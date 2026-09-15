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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return this.captureScreenshotCommand(sessionName, ['screenshot'], 300, format)
      },
      { ensureVisible: false }
    )
  }

  async fullPageScreenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        return this.captureFullPageScreenshotCommand(
          sessionName,
          target.webContentsId,
          500,
          format === 'jpeg' ? 'jpeg' : 'png'
        )
      },
      { ensureVisible: false }
    )
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

  private async captureScreenshotCommand(
    sessionName: string,
    commandArgs: string[],
    settleMs: number,
    format?: string
  ): Promise<BrowserScreenshotResult> {
    return this.withSerializedScreenshotAccess(async () => {
      const session = this.sessions.get(sessionName)
      const restore = session
        ? await this.browserManager.acquireAutomationVisibility(session.webContentsId)
        : () => {}
      try {
        // Why: let the compositor settle to a painted frame after the lease, inside the screenshot lock so another tab can't change lease state first.
        await new Promise((r) => setTimeout(r, settleMs))
        const raw = await this.execAgentBrowser(sessionName, commandArgs)
        return this.readScreenshotFromResult(raw, format)
      } finally {
        restore()
      }
    })
  }

  private async captureFullPageScreenshotCommand(
    sessionName: string,
    webContentsId: number,
    settleMs: number,
    format: 'png' | 'jpeg'
  ): Promise<BrowserScreenshotResult> {
    return this.withSerializedScreenshotAccess(async () => {
      const session = this.sessions.get(sessionName)
      const restore = session
        ? await this.browserManager.acquireAutomationVisibility(session.webContentsId)
        : () => {}
      try {
        // Why: the guest compositor needs a beat to paint a fresh frame after becoming paintable, or CDP captures a stale surface.
        await new Promise((r) => setTimeout(r, settleMs))
        const wc = this.getWebContents(webContentsId)
        if (!wc) {
          throw new BrowserError('browser_tab_not_found', 'Tab is no longer available')
        }
        return await captureFullPageScreenshot(wc, format)
      } catch (error) {
        throw new BrowserError('browser_error', (error as Error).message)
      } finally {
        restore()
      }
    })
  }

  private async withSerializedScreenshotAccess<T>(execute: () => Promise<T>): Promise<T> {
    const previousTurn = this.screenshotTurn.catch(() => {})
    let releaseTurn!: () => void
    this.screenshotTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    await previousTurn
    try {
      return await execute()
    } finally {
      releaseTurn()
    }
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
