import type {
  BrowserSelectResult,
  BrowserScrollResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../../../shared/clipboard/clipboard-text'
import { iterateBrowserTextInsertionChunks } from '../../../../shared/browser/automation/browser-text-insertion-chunks'
import { AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES } from '../protocol/agent-browser-text-argument-budget'
import { AgentBrowserBridgeCoreCommands } from './agent-browser-bridge-core-commands'
import { SELECT_OPTION_TARGET_FUNCTION } from '../../cdp/input/browser-element-functions'
import { BrowserError } from '../../browser-error'
import { acquireElectronDebugger } from '../../cdp/debugger/electron-debugger-lease'
import { waitForGuestFirstPaint } from '../../cdp/debugger/guest-first-paint'
import { sendGuestCdpCommand } from '../../cdp/debugger/guest-cdp-command'
import { assertExpectedPageUrlForStep } from '../../cdp/input/browser-expected-page-url'
import type { GuestSessionCdpSender } from '../../cdp/input/guest-frame-input-sessions'
import { routePageTextInsertion } from '../../cdp/input/guest-direct-key-input'

export abstract class AgentBrowserBridgeInputCommands extends AgentBrowserBridgeCoreCommands {
  async select(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectResult> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        // The helper reports success for any element; only a <select> has options to choose.
        await this.actOnElement(
          sessionName,
          element,
          'select an option in',
          SELECT_OPTION_TARGET_FUNCTION
        )
        return (await this.execAgentBrowser(sessionName, [
          'select',
          element,
          value
        ])) as BrowserSelectResult
      },
      { elements: [element] }
    )
  }

  async scroll(
    direction: string,
    amount?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScrollResult> {
    return this.enqueueInertAction(worktreeId, browserPageId, async (sessionName) => {
      const args = ['scroll', direction]
      if (amount != null) {
        args.push(String(amount))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserScrollResult
    })
  }

  async scrollIntoView(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueInertAction(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return await this.execAgentBrowser(sessionName, ['scrollintoview', element])
      },
      { elements: [element] }
    )
  }

  async get(
    what: string,
    selector?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        const args = ['get', what]
        if (selector) {
          args.push(selector)
        }
        return await this.execAgentBrowser(sessionName, args)
      },
      { elements: [selector] }
    )
  }

  async is(
    what: string,
    selector: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return await this.execAgentBrowser(sessionName, ['is', what, selector])
      },
      { elements: [selector] }
    )
  }

  async keyboardInsertText(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    await assertClipboardTextWriteWithinLimitWithYield(text)
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          const send: GuestSessionCdpSender = (method, params, sessionId) =>
            sendGuestCdpCommand(wc, method, params, sessionId)
          await waitForGuestFirstPaint(wc, send, () =>
            this.browserManager.holdPaintForCapture(target.webContentsId)
          )
          const route = await routePageTextInsertion(wc, send)
          for (const chunk of iterateBrowserTextInsertionChunks(
            text,
            AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
          )) {
            assertExpectedPageUrlForStep()
            await route.deliver({ text: chunk })
          }
          return { inserted: true }
        } catch (error) {
          if (error instanceof BrowserError) {
            throw error
          }
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(sessionName)
          }
          throw new BrowserError(
            'browser_error',
            `Failed to insert text in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false, requireScopedTarget: true }
    )
  }
}
