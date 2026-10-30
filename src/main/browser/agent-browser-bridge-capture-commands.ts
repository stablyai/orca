import { existsSync, readFileSync, rmSync } from 'node:fs'
import { z } from 'zod'
import { nativeImage, type WebContents } from 'electron'
import type {
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserEvalResult
} from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { captureFullPageScreenshot } from './cdp-screenshot'
import {
  AgentBrowserScreenshotResult,
  agentBrowserScreenshotArgs
} from './agent-browser-screenshot-arguments'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { AgentBrowserBridgeUtilityCommands } from './agent-browser-bridge-utility-commands'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { captureRemoteCliBrowserWorkBound } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

export abstract class AgentBrowserBridgeCaptureCommands extends AgentBrowserBridgeUtilityCommands {
  async screenshot(
    options: BrowserScreenshotOptions,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName, target) => {
      const wc = this.requireTargetWebContents(target)
      const raw = await this.execAgentBrowser(sessionName, agentBrowserScreenshotArgs(options), {
        cliArgv: true
      })
      return this.readScreenshotFromResult(raw, options.format, wc)
    })
  }

  async fullPageScreenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.requireTargetWebContents(target)
      try {
        return await captureFullPageScreenshot(wc, format === 'jpeg' ? 'jpeg' : 'png', () =>
          this.browserManager.holdPaintForCapture(target.webContentsId)
        )
      } catch (error) {
        throw new BrowserError('browser_error', (error as Error).message)
      }
    })
  }

  private async readScreenshotFromResult(
    raw: unknown,
    format: BrowserScreenshotOptions['format'],
    wc: WebContents
  ): Promise<BrowserScreenshotResult> {
    const screenshotFormat = format === 'jpeg' ? 'jpeg' : 'png'
    const parsed = AgentBrowserScreenshotResult.safeParse(raw)
    if (!parsed.success) {
      throw new BrowserError('browser_error', 'Screenshot returned no file path')
    }
    const { path, changed, annotations } = parsed.data
    if (!path) {
      if (changed === false) {
        return { data: '', format: screenshotFormat, changed, annotations }
      }
      throw new BrowserError('browser_error', 'Screenshot returned no file path')
    }
    if (!existsSync(path)) {
      throw new BrowserError('browser_error', `Screenshot file not found: ${path}`)
    }
    try {
      const data = await readInCssPixels(path, screenshotFormat, wc)
      return { data, format: screenshotFormat, changed, annotations }
    } finally {
      // agent-browser keeps every capture in its own temp folder; the bytes are ours now.
      rmSync(path, { force: true })
    }
  }

  async evaluate(
    expression: string,
    worktreeId?: string,
    browserPageId?: string,
    signal?: AbortSignal
  ): Promise<BrowserEvalResult> {
    // Capture the host's scope before the queue can run this command elsewhere.
    const bound = captureRemoteCliBrowserWorkBound()
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        throwIfSignalAborted(signal)
        const wc = this.requireTargetWebContents(target)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          // A caller leaving frees the page queue but does not terminate its script.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime.evaluate with returnByValue always answers this CDP shape; unchanged from before the bound.
          const { result, exceptionDetails } = (await waitForPromiseWithSignal(
            bound(
              sendGuestCdpCommand(wc, 'Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true
              }),
              () => void wc.debugger.sendCommand('Runtime.terminateExecution').catch(() => {})
            ),
            signal
          )) as {
            result: { value?: unknown; description?: string }
            exceptionDetails?: { text: string; exception?: { description?: string } }
          }
          if (exceptionDetails) {
            throw new BrowserError(
              'browser_eval_error',
              exceptionDetails.exception?.description ?? exceptionDetails.text
            )
          }

          const currentTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
          if (currentTarget.webContentsId !== target.webContentsId) {
            throw new BrowserError(
              'browser_tab_changed',
              `Browser page ${target.browserPageId} changed while evaluating; retry the command`
            )
          }
          return {
            result:
              result.value !== undefined
                ? typeof result.value === 'object' && result.value !== null
                  ? JSON.stringify(result.value)
                  : String(result.value)
                : (result.description ?? ''),
            origin: wc.getURL()
          }
        } catch (error) {
          if (error instanceof BrowserError) {
            throw error
          }
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(
              `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
            )
          }
          throw new BrowserError(
            'browser_error',
            `Failed to evaluate in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false }
    )
  }
}

const CssViewportMetrics = z.object({
  cssVisualViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() })
})

// Captures come back in device pixels (HiDPI, zoom, emulated DPR); CSS pixels keep x/y equal to page coordinates.
async function readInCssPixels(
  path: string,
  format: 'png' | 'jpeg',
  wc: WebContents
): Promise<string> {
  const lease = acquireElectronDebugger(wc)
  let metrics: unknown
  try {
    metrics = await sendGuestCdpCommand(wc, 'Page.getLayoutMetrics', {})
  } catch (error) {
    throw new BrowserError(
      'browser_error',
      `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    lease.release()
  }
  const bytes = readFileSync(path)
  const viewport = CssViewportMetrics.safeParse(metrics)
  const image = nativeImage.createFromBuffer(bytes)
  const { width, height } = image.getSize()
  if (!viewport.success || width === 0 || height === 0) {
    return bytes.toString('base64')
  }
  // The viewport sizes leave out scrollbars the image includes; the axis without one gives the true ratio.
  const { clientWidth, clientHeight } = viewport.data.cssVisualViewport
  const scale = Math.max(clientWidth / width, clientHeight / height)
  const cssWidth = Math.round(width * scale)
  if (!(scale > 0) || cssWidth >= width) {
    return bytes.toString('base64')
  }
  const resized = image.resize({ width: cssWidth, quality: 'best' })
  return (format === 'jpeg' ? resized.toJPEG(90) : resized.toPNG()).toString('base64')
}
