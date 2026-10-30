import type {
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserPdfResult
} from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import {
  FILE_INPUT_TARGET_FUNCTION,
  FILL_ELEMENT_FUNCTION,
  SELECT_ALL_ELEMENT_FUNCTION
} from './browser-element-functions'
import { assertUploadFilesExist } from './browser-upload-files'
import {
  agentBrowserWaitArguments,
  type AgentBrowserWaitOptions
} from './agent-browser-wait-arguments'
import { parseCdpKeyEvent } from './cdp-keyboard-us-layout'
import { readRemoteCliAdmittedPage } from './remote-cli-page-admission'
import { AgentBrowserBridgeKeyCommands } from './agent-browser-bridge-key-commands'

export abstract class AgentBrowserBridgeInteractionCommands extends AgentBrowserBridgeKeyCommands {
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
        await assertUploadFilesExist(filePaths)
        await this.actOnElement(sessionName, element, 'upload to', FILE_INPUT_TARGET_FUNCTION)
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
        await this.actOnElement(sessionName, element, 'clear', FILL_ELEMENT_FUNCTION, [''])
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
      async (sessionName, target) => {
        const focused = await this.actOnElement(
          sessionName,
          element,
          'select all in',
          SELECT_ALL_ELEMENT_FUNCTION
        )
        // Code editors select their whole document from the shortcut, beyond the DOM they render;
        // an element that can't take focus keeps the DOM selection instead.
        const shortcut = parseCdpKeyEvent(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
        if (focused === true && shortcut) {
          await this.pressKeysInPage(sessionName, target, [shortcut])
        }
        return { selected: element }
      },
      { elements: [element] }
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
