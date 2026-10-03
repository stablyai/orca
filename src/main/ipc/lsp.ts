import { ipcMain, MessageChannelMain, type MessagePortMain } from 'electron'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import {
  LSP_PORT_CHANNEL,
  type LspOpenArgs,
  type LspOpenResult
} from '../../shared/language-server-types'
import type { Store } from '../persistence'
import type { LspPort } from '../lsp/lsp-session'
import type { LspSessionManager } from '../lsp/lsp-session-manager'
import { probeRepoLanguageServers } from '../lsp/lsp-probe'

function isLspOpenArgs(value: unknown): value is LspOpenArgs {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.languageId === 'string'
  )
}

function toLspPort(port: MessagePortMain): LspPort {
  return {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', (event) => listener(event.data))
    },
    onClose: (listener) => {
      port.on('close', listener)
    },
    close: () => port.close()
  }
}

export function registerLspHandlers(manager: LspSessionManager, store: Store): void {
  ipcMain.removeHandler('lsp:open')
  ipcMain.handle('lsp:open', async (event, args: unknown): Promise<LspOpenResult> => {
    if (!isLspOpenArgs(args)) {
      return { ok: false, reason: 'invalid-worktree' }
    }
    const acquired = await manager.acquire({
      worktreeId: args.worktreeId,
      languageId: args.languageId
    })
    if (!acquired.ok) {
      return acquired
    }
    if (event.sender.isDestroyed()) {
      return { ok: false, reason: 'unavailable' }
    }
    const { port1, port2 } = new MessageChannelMain()
    // Why: attach only after delivery so a failed post never leaves a client-less session.
    try {
      event.sender.postMessage(LSP_PORT_CHANNEL, { requestId: args.requestId }, [port2])
    } catch {
      port1.close()
      port2.close()
      return { ok: false, reason: 'unavailable' }
    }
    acquired.session.attachPort(toLspPort(port1))
    port1.start()
    return { ok: true, sessionKey: acquired.key }
  })

  ipcMain.removeHandler('lsp:probe')
  ipcMain.handle('lsp:probe', async (_event, args: unknown) => {
    const repoId = isRecord(args) && typeof args.repoId === 'string' ? args.repoId : null
    const repo = repoId ? store.getRepo(repoId) : undefined
    return repo ? probeRepoLanguageServers(repo) : {}
  })
}
