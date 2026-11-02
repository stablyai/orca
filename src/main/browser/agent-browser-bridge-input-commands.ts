import type { BrowserSelectResult, BrowserScrollResult } from '../../shared/runtime-types'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { iterateBrowserTextInsertionChunks } from '../../shared/browser-text-insertion-chunks'
import { AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES } from './agent-browser-bridge-types'
import { AgentBrowserBridgeCoreCommands } from './agent-browser-bridge-core-commands'
import { SELECT_OPTION_TARGET_FUNCTION } from './browser-element-functions'

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
    return this.enqueuePageAction(worktreeId, browserPageId, async (sessionName) => {
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
    return this.enqueuePageAction(
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
      async (sessionName) => {
        let result: unknown = { inserted: true }
        for (const chunk of iterateBrowserTextInsertionChunks(
          text,
          AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
        )) {
          result = await this.execAgentBrowser(sessionName, ['keyboard', 'inserttext', chunk])
        }
        return result
      },
      { requireScopedTarget: true }
    )
  }
}
