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
  FILE_INPUT_FRAME_URL_FUNCTION,
  FILE_UPLOAD_TARGET_FUNCTION,
  FILL_ELEMENT_FUNCTION,
  SELECT_ALL_ELEMENT_FUNCTION
} from './browser-element-functions'
import { assertUploadFilesExist } from './browser-upload-files'
import type { WebContents } from 'electron'
import type { CapturedElement } from './cdp-element-capture'
import { interceptFileChooser, type OpenedFileChooser } from './guest-file-chooser'
import { readRecord, readString } from './guest-frame-input-sessions'
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
    return this.enqueuePageAction(
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
    return this.enqueuePageAction(
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
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        await assertUploadFilesExist(filePaths)
        const target = await this.captureElement(sessionName, element)
        const { wc, captured } = target
        const chooser = await interceptFileChooser(wc, captured.sessionId)
        try {
          const isFileInput = await this.callElementFunction(
            sessionName,
            target,
            element,
            'upload to',
            FILE_UPLOAD_TARGET_FUNCTION,
            { userGesture: true }
          )
          const input =
            isFileInput === true
              ? captured
              : await this.openedFileInput(sessionName, wc, element, await chooser.next())
          const frame = await this.sendElementCdpCommand(
            sessionName,
            wc,
            'Runtime.callFunctionOn',
            {
              objectId: input.objectId,
              functionDeclaration: FILE_INPUT_FRAME_URL_FUNCTION,
              returnByValue: true
            },
            input.sessionId
          )
          const frameUrl = readRecord(frame, 'result')?.value
          await this.sendElementCdpCommand(
            sessionName,
            wc,
            'DOM.setFileInputFiles',
            { files: filePaths, objectId: input.objectId },
            input.sessionId
          )
          return {
            uploaded: filePaths.length,
            ...(typeof frameUrl === 'string' ? { frameUrl } : {})
          }
        } finally {
          await chooser.release()
        }
      },
      { elements: [element] }
    )
  }

  private async openedFileInput(
    sessionName: string,
    wc: WebContents,
    element: string,
    opened: OpenedFileChooser | null
  ): Promise<CapturedElement> {
    if (!opened?.backendNodeId) {
      throw new BrowserError(
        'browser_element_not_interactable',
        `Cannot upload to ${element}: ${opened ? 'its file picker has no file input' : 'clicking it opened no file picker'}`
      )
    }
    const resolved = await this.sendElementCdpCommand(
      sessionName,
      wc,
      'DOM.resolveNode',
      { backendNodeId: opened.backendNodeId },
      opened.sessionId
    )
    const objectId = readString(readRecord(resolved, 'object'), 'objectId')
    if (!objectId) {
      throw new BrowserError('browser_error', `Could not resolve the file input ${element} opened`)
    }
    return { objectId, sessionId: opened.sessionId }
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
    return this.enqueuePageAction(
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
    return this.enqueuePageAction(
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
    return this.enqueuePageAction(
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
    return this.enqueuePageAction(
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
