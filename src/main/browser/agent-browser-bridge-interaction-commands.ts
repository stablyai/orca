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
import { WAIT_PROCESS_TIMEOUT_GRACE_MS } from './agent-browser-bridge-types'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { parseCdpKeyEvent, imeFallbackKeyEvent } from './cdp-keyboard-us-layout'
import { AgentBrowserBridgeCaptureCommands } from './agent-browser-bridge-capture-commands'

export abstract class AgentBrowserBridgeInteractionCommands extends AgentBrowserBridgeCaptureCommands {
  async hover(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserHoverResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['hover', element])) as BrowserHoverResult
    })
  }

  async drag(
    from: string,
    to: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserDragResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['drag', from, to])) as BrowserDragResult
    })
  }

  async upload(
    element: string,
    filePaths: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserUploadResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'upload',
        element,
        ...filePaths
      ])) as BrowserUploadResult
    })
  }

  async wait(
    options?: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    },
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserWaitResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['wait']

      const hasCondition =
        !!options?.selector || !!options?.text || !!options?.url || !!options?.load || !!options?.fn

      if (options?.selector) {
        args.push(options.selector)
      } else if (options?.timeout != null && !hasCondition) {
        args.push(String(options.timeout))
      }

      if (options?.text) {
        args.push('--text', options.text)
      }

      if (options?.url) {
        args.push('--url', options.url)
      }

      if (options?.load) {
        args.push('--load', options.load)
      }

      if (options?.fn) {
        args.push('--fn', options.fn)
      }

      const normalizedState = options?.state === 'visible' ? undefined : options?.state

      if (normalizedState) {
        args.push('--state', normalizedState)
      }

      // Why: agent-browser's selector wait lacks a per-command timeout — enforce it here so a missing selector fails as browser_timeout, not a hang.
      return (await this.execAgentBrowser(sessionName, args, {
        timeoutMs:
          options?.timeout != null && hasCondition
            ? options.timeout + WAIT_PROCESS_TIMEOUT_GRACE_MS
            : undefined,
        timeoutError:
          options?.timeout != null && hasCondition
            ? new BrowserError(
                'browser_timeout',
                `Timed out waiting for browser condition after ${options.timeout}ms.`
              )
            : undefined
      })) as BrowserWaitResult
    })
  }

  async check(
    element: string,
    checked: boolean,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCheckResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = checked ? ['check', element] : ['uncheck', element]

      return (await this.execAgentBrowser(sessionName, args)) as BrowserCheckResult
    })
  }

  async focus(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFocusResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['focus', element])) as BrowserFocusResult
    })
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
          // Why: agent-browser resolves the ref directly, preserving iframe/shadow-root/unfocusable semantics for ordinary fields.
          await this.execAgentBrowser(sessionName, ['fill', element, ''])

          return { cleared: element }
        }

        await this.fillExplicitContentEditable(sessionName, element, '')

        return { cleared: element }
      },
      { requireScopedTarget: true }
    )
  }

  async selectAll(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectAllResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser has no select-all command — implement as focus + Ctrl+A
      await this.execAgentBrowser(sessionName, ['focus', element])

      return (await this.execAgentBrowser(sessionName, [
        'press',
        'Control+a'
      ])) as BrowserSelectAllResult
    })
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
          // Why: a key name the table cannot express must not dispatch keyCode 0 and
          // report success — route it to the helper, creating its session only now so
          // the direct path never pays for it.
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
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            // Why: rawKeyDown is the no-character form; sending keyDown without text
            // makes Blink synthesize an empty input for editing keys.
            type: parsed.text === null ? 'rawKeyDown' : 'keyDown',
            ...event,
            ...(parsed.text === null ? {} : { text: parsed.text, unmodifiedText: parsed.text })
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            ...event,
            // Why: the self bit is keydown-only -- Blink reports shiftKey false on the Shift keyup.
            modifiers: parsed.modifiers & ~parsed.selfModifier
          })

          return { pressed: key }
        } catch (error) {
          // Why: attach/dispatch reject with plain Errors, which the RPC layer would report as
          // runtime_error — the helper path this replaced always produced a browser_* code, and
          // the pane only reclaims a dead page when it sees one.
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
      { ensureSession: false }
    )
  }

  async pdf(worktreeId?: string, browserPageId?: string): Promise<BrowserPdfResult> {
    // Why: agent-browser's CDP printToPDF hangs in Electron webviews — use the native webContents.printToPDF().
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)

      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }

      const buffer = await wc.printToPDF({
        printBackground: true,
        preferCSSPageSize: true
      })

      return { data: buffer.toString('base64') }
    })
  }
}
