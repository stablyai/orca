import type {
  BrowserSelectResult,
  BrowserScrollResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { AgentBrowserBridgeCoreCommands } from './agent-browser-bridge-core-commands'
import { SELECT_OPTION_TARGET_FUNCTION } from '../../cdp/input/browser-element-functions'
import { redactBrowserMetadataGetter } from '../../../../shared/browser/browser-metadata-redaction'

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
        return redactBrowserMetadataGetter(what, await this.execAgentBrowser(sessionName, args))
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
}
