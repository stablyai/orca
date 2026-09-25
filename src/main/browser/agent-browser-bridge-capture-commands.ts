import { existsSync, readFileSync } from 'node:fs'
import type { BrowserScreenshotResult, BrowserEvalResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { captureFullPageScreenshot } from './cdp-screenshot'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { AgentBrowserBridgeUtilityCommands } from './agent-browser-bridge-utility-commands'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'

export abstract class AgentBrowserBridgeCaptureCommands extends AgentBrowserBridgeUtilityCommands {
  async screenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    // Why: agent-browser writes the screenshot to a temp file and returns its path; read it and return base64.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return this.readScreenshotFromResult(
        await this.execAgentBrowser(sessionName, ['screenshot']),
        format
      )
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

  private readScreenshotFromResult(raw: unknown, format?: string): BrowserScreenshotResult {
    const parsed = raw as { path?: string } | undefined
    if (!parsed?.path) {
      throw new BrowserError('browser_error', 'Screenshot returned no file path')
    }
    if (!existsSync(parsed.path)) {
      throw new BrowserError('browser_error', `Screenshot file not found: ${parsed.path}`)
    }
    const data = readFileSync(parsed.path).toString('base64')
    return { data, format: format === 'jpeg' ? 'jpeg' : 'png' } as BrowserScreenshotResult
  }

  async evaluate(
    expression: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserEvalResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          const { result, exceptionDetails } = (await wc.debugger.sendCommand('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
          })) as {
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
