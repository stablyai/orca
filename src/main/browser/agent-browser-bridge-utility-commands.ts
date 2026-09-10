import { BrowserError } from './cdp-bridge'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES } from './agent-browser-bridge-types'
import type { BrowserBackResult, BrowserReloadResult } from '../../shared/runtime-types'
import { AgentBrowserBridgeMouseCommands } from './agent-browser-bridge-mouse-commands'

export abstract class AgentBrowserBridgeUtilityCommands extends AgentBrowserBridgeMouseCommands {
  // ── Clipboard commands ──

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

  // ── Dialog commands ──

  async dialogAccept(text?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['dialog', 'accept']
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async dialogDismiss(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['dialog', 'dismiss'])
    })
  }

  // ── Storage commands ──

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

  // ── Download command ──

  async download(
    selector: string,
    path: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['download', selector, path])
    })
  }

  // ── Highlight command ──

  async highlight(selector: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['highlight', selector])
    })
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
    // Why: reload can trigger an Electron process swap that destroys the session mid-command — reload via webContents directly instead.
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
        // Why: clear the fallback timer on load; otherwise each reload leaks the webContents + listeners until the 10s timeout.
        fallbackTimer = setTimeout(finish, 10_000)
        if (typeof fallbackTimer.unref === 'function') {
          fallbackTimer.unref()
        }
      })
      return { url: wc.getURL(), title: wc.getTitle() }
    })
  }
}
