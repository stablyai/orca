import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { BrowserError } from './cdp-bridge'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import {
  AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES,
  AGENT_DOWNLOAD_REPLY_DEADLINE_MS,
  AGENT_DOWNLOAD_START_TIMEOUT_MS
} from './agent-browser-bridge-types'
import type { BrowserBackResult, BrowserReloadResult } from '../../shared/runtime-types'
import { AgentBrowserBridgeMouseCommands } from './agent-browser-bridge-mouse-commands'
import {
  answerBrowserJavaScriptDialog,
  getBrowserJavaScriptDialog
} from './browser-javascript-dialogs'
import { captureRemoteCliBrowserRevocation } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

export abstract class AgentBrowserBridgeUtilityCommands extends AgentBrowserBridgeMouseCommands {
  async clipboardRead(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'read'])
    })
  }

  async clipboardWrite(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    await assertClipboardTextWriteWithinLimitWithYield(text, {
      maxBytes: AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES
    })
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'write', text])
    })
  }

  async dialogAccept(text?: string, worktreeId?: string, browserPageId?: string): Promise<void> {
    this.answerDialog(true, text, worktreeId, browserPageId)
  }

  async dialogDismiss(worktreeId?: string, browserPageId?: string): Promise<void> {
    this.answerDialog(false, undefined, worktreeId, browserPageId)
  }

  // Not queued: the page's queued commands wait on this answer.
  private answerDialog(
    accept: boolean,
    text: string | undefined,
    worktreeId: string | undefined,
    browserPageId: string | undefined
  ): void {
    this.assertCommandAdmission()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    const { webContentsId } = this.resolveCommandTarget(worktreeId, browserPageId)
    assertNotRevoked(webContentsId)
    // Chrome answers an untouched prompt with its default text.
    const promptText = text ?? getBrowserJavaScriptDialog(webContentsId)?.defaultPromptText ?? ''
    if (!answerBrowserJavaScriptDialog(webContentsId, { accept, promptText })) {
      throw new BrowserError('browser_no_dialog', 'No JavaScript dialog is open on this page')
    }
  }

  async storageLocalGet(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'get', key])
    })
  }

  async storageLocalSet(
    key: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'set', key, value])
    })
  }

  async storageLocalClear(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'clear'])
    })
  }

  async storageSessionGet(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'get', key])
    })
  }

  async storageSessionSet(
    key: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'set', key, value])
    })
  }

  async storageSessionClear(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'clear'])
    })
  }

  // Orca's will-download handler picks every save path, so agent-browser's own download
  // (CDP download behavior + rename) never sees the file; claim the download here instead.
  async download(
    selector: string,
    savePath: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<{ path: string }> {
    if (!path.isAbsolute(savePath)) {
      throw new BrowserError('invalid_argument', `--path must be an absolute path: ${savePath}`)
    }
    const replyDeadline = Date.now() + AGENT_DOWNLOAD_REPLY_DEADLINE_MS
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        await mkdir(path.dirname(savePath), { recursive: true })
        const claim = this.browserManager.claimNextDownload(target.webContentsId, savePath)
        try {
          await this.execAgentBrowser(sessionName, ['click', selector])
          if (!(await withTimeout(claim.started, AGENT_DOWNLOAD_START_TIMEOUT_MS, false))) {
            throw new BrowserError(
              'browser_download_not_started',
              `Clicking ${selector} did not start a download within ${AGENT_DOWNLOAD_START_TIMEOUT_MS / 1000}s.`
            )
          }
          const finished = await withTimeout(
            claim.finished,
            Math.max(0, replyDeadline - Date.now()),
            null
          )
          if (!finished) {
            throw new BrowserError(
              'browser_download_in_progress',
              `The download is still in progress and will be saved to ${savePath}.`
            )
          }
          if (finished.status !== 'completed') {
            throw new BrowserError(
              'browser_download_failed',
              finished.error ?? `The download was ${finished.status}.`
            )
          }
          return { path: savePath }
        } finally {
          claim.release()
        }
      },
      { elements: [selector] }
    )
  }

  async highlight(selector: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return await this.execAgentBrowser(sessionName, ['highlight', selector])
      },
      { elements: [selector] }
    )
  }

  async back(worktreeId?: string, browserPageId?: string): Promise<BrowserBackResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['back'])) as BrowserBackResult
    })
  }

  async forward(worktreeId?: string, browserPageId?: string): Promise<BrowserBackResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['forward'])) as BrowserBackResult
    })
  }

  async reload(worktreeId?: string, browserPageId?: string): Promise<BrowserReloadResult> {
    // Reload directly because a process swap can destroy the helper session mid-command.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      wc.reload()
      await new Promise<void>((resolve) => {
        let settled = false
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null

        const finish = (): void => {
          if (settled) {
            return
          }
          settled = true
          wc.removeListener('did-finish-load', onFinish)
          wc.removeListener('did-fail-load', onFail)
          if (fallbackTimer) {
            clearTimeout(fallbackTimer)
            fallbackTimer = null
          }
          resolve()
        }
        const onFinish = (): void => finish()
        const onFail = (): void => finish()

        wc.on('did-finish-load', onFinish)
        wc.on('did-fail-load', onFail)
        // Clear this timer on load to release WebContents and listeners promptly.
        fallbackTimer = setTimeout(finish, 10_000)
        if (typeof fallbackTimer.unref === 'function') {
          fallbackTimer.unref()
        }
      })
      return { url: wc.getURL(), title: wc.getTitle() }
    })
  }
}
