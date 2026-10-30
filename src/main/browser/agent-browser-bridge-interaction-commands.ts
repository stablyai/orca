import type {
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult
} from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import {
  agentBrowserWaitArguments,
  type AgentBrowserWaitOptions
} from './agent-browser-wait-arguments'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { parseCdpKeyEvent, imeFallbackKeyEvent } from './cdp-keyboard-us-layout'
import { dispatchPageKeyEvent, type GuestCdpSender } from './guest-direct-key-input'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { readRemoteCliAdmittedPage } from './remote-cli-page-admission'
import { AgentBrowserBridgeCaptureCommands } from './agent-browser-bridge-capture-commands'

export abstract class AgentBrowserBridgeInteractionCommands extends AgentBrowserBridgeCaptureCommands {
  async hover(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserHoverResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return (await this.execAgentBrowser(sessionName, ['hover', element])) as BrowserHoverResult
      },
      { elements: [element] }
    )
  }

  async drag(
    from: string,
    to: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserDragResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return (await this.execAgentBrowser(sessionName, ['drag', from, to])) as BrowserDragResult
      },
      { elements: [from, to] }
    )
  }

  async upload(
    element: string,
    filePaths: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserUploadResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return (await this.execAgentBrowser(sessionName, [
          'upload',
          element,
          ...filePaths
        ])) as BrowserUploadResult
      },
      { elements: [element] }
    )
  }

  async wait(
    options?: AgentBrowserWaitOptions,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserWaitResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        const { args, conditionTimeoutMs, processTimeoutMs } = agentBrowserWaitArguments(
          options ?? {}
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent-browser's wait --json answers the BrowserWaitResult shape.
        return (await this.execAgentBrowser(sessionName, args, {
          timeoutMs: processTimeoutMs,
          timeoutError:
            conditionTimeoutMs === undefined
              ? undefined
              : new BrowserError(
                  'browser_timeout',
                  `Timed out waiting for browser condition after ${conditionTimeoutMs}ms.`
                )
        })) as BrowserWaitResult
      },
      { elements: [options?.selector] }
    )
  }

  async check(
    element: string,
    checked: boolean,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCheckResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        const args = checked ? ['check', element] : ['uncheck', element]
        return (await this.execAgentBrowser(sessionName, args)) as BrowserCheckResult
      },
      { elements: [element] }
    )
  }

  async focus(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFocusResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return (await this.execAgentBrowser(sessionName, ['focus', element])) as BrowserFocusResult
      },
      { elements: [element] }
    )
  }

  async clear(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClearResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        if (!(await this.isExplicitContentEditableTarget(sessionName, element))) {
          // Let the helper resolve ordinary refs inside iframes and shadow roots, including unfocusable fields.
          await this.execAgentBrowser(sessionName, ['fill', element, ''])
          return { cleared: element }
        }

        await this.fillExplicitContentEditable(sessionName, element, '')
        return { cleared: element }
      },
      { requireScopedTarget: true, elements: [element] }
    )
  }

  async selectAll(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectAllResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        await this.execAgentBrowser(sessionName, ['focus', element])
        return (await this.execAgentBrowser(sessionName, [
          'press',
          'Control+a'
        ])) as BrowserSelectAllResult
      },
      { elements: [element] }
    )
  }

  async keypress(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserKeypressResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        const parsed = parseCdpKeyEvent(key) ?? imeFallbackKeyEvent(key)
        if (!parsed) {
          // Unknown keys need the helper; create its session only on this fallback path.
          await this.ensureSession(sessionName, target.browserPageId, target.webContentsId)
          return (await this.execAgentBrowser(sessionName, ['press', key])) as BrowserKeypressResult
        }
        const wc = this.getWebContents(target.webContentsId)
        if (!wc || wc.isDestroyed()) {
          throw new BrowserError(
            'browser_tab_not_found',
            `Browser page ${target.browserPageId} is no longer available`
          )
        }
        const event = {
          windowsVirtualKeyCode: parsed.keyCode,
          nativeVirtualKeyCode: parsed.keyCode,
          key: parsed.key,
          code: parsed.code,
          modifiers: parsed.modifiers,
          location: parsed.location
        }
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          await this.waitForPagePaint(wc, target.webContentsId)
          const send: GuestCdpSender = (method, params, sessionId) =>
            sendGuestCdpCommand(wc, method, params, sessionId)
          const guardFocus = (): Promise<() => void> =>
            this.browserManager.guardUserFocusForAgentInput(target.webContentsId)
          await dispatchPageKeyEvent(
            wc,
            {
              // keyDown without text makes Blink synthesize empty input; use rawKeyDown for editing keys.
              type: parsed.text === null ? 'rawKeyDown' : 'keyDown',
              ...event,
              ...(parsed.text === null ? {} : { text: parsed.text, unmodifiedText: parsed.text })
            },
            send,
            guardFocus
          )
          await dispatchPageKeyEvent(
            wc,
            {
              type: 'keyUp',
              ...event,
              // Blink clears a modifier's own bit on keyup.
              modifiers: parsed.modifiers & ~parsed.selfModifier
            },
            send,
            guardFocus
          )
          return { pressed: key }
        } catch (error) {
          // Browser error codes let the pane recognize and reclaim a dead page.
          if (error instanceof BrowserError) {
            throw error
          }
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(sessionName)
          }
          throw new BrowserError(
            'browser_error',
            `Failed to press ${key} in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false, requireScopedTarget: true }
    )
  }

  async pdf(worktreeId?: string, browserPageId?: string): Promise<BrowserPdfResult> {
    // Native printing avoids helper CDP hangs and lays out undrawn pages without a paint hold.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      const buffer = await readRemoteCliAdmittedPage(wc.id, () =>
        wc.printToPDF({ printBackground: true, preferCSSPageSize: true })
      )
      return { data: buffer.toString('base64') }
    })
  }
}
