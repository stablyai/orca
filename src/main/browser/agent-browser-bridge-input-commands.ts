import type {
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult
} from '../../shared/runtime-types'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { iterateBrowserTextInsertionChunks } from './browser-text-insertion'
import { AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES } from './agent-browser-bridge-types'
import { AgentBrowserBridgeCoreCommands } from './agent-browser-bridge-core-commands'

export abstract class AgentBrowserBridgeInputCommands extends AgentBrowserBridgeCoreCommands {
  async type(
    input: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTypeResult> {
    await assertClipboardTextWriteWithinLimitWithYield(input)
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        for (const chunk of iterateBrowserTextInsertionChunks(
          input,
          AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
        )) {
          await this.execAgentBrowser(sessionName, ['keyboard', 'type', chunk])
        }
        return { typed: true } as BrowserTypeResult
      },
      { requireScopedTarget: true }
    )
  }

  async select(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'select',
        element,
        value
      ])) as BrowserSelectResult
    })
  }

  async scroll(
    direction: string,
    amount?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScrollResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
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
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['scrollintoview', element])
    })
  }

  async get(
    what: string,
    selector?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['get', what]
      if (selector) {
        args.push(selector)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async is(
    what: string,
    selector: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['is', what, selector])
    })
  }

  // ── Keyboard commands ──

  async keyboardInsertText(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    await assertClipboardTextWriteWithinLimitWithYield(text)
    return this.enqueueTargetedCommand(
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
