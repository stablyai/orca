import { ipcMain } from 'electron'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import { clearMigrationUnsupportedPtysForPaneKey } from '../agent-hooks/migration-unsupported-pty-state'

const MAX_PTY_ID_LENGTH = 512

export type AgentPaneAuthorityOwnership = {
  ownsPty: (paneKey: string, ptyId: string) => boolean
}

export function registerAgentPaneAuthorityIpcHandlers(
  ownership: AgentPaneAuthorityOwnership
): void {
  ipcMain.removeAllListeners('agentStatus:retirePaneAuthority')
  ipcMain.removeAllListeners('agentStatus:transferPaneAuthority')
  ipcMain.on('agentStatus:retirePaneAuthority', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      agentHookServer.retirePaneAuthority(paneKey)
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] retirePaneAuthority failed:', err)
    }
  })
  ipcMain.on('agentStatus:transferPaneAuthority', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') {
      return
    }
    const args = value as Record<string, unknown>
    const ptyId = typeof args.ptyId === 'string' ? args.ptyId : undefined
    if (
      typeof args.fromPaneKey !== 'string' ||
      typeof args.toPaneKey !== 'string' ||
      !isValidPaneKey(args.fromPaneKey) ||
      !isValidPaneKey(args.toPaneKey) ||
      args.fromPaneKey === args.toPaneKey ||
      (args.ptyId !== undefined &&
        (typeof args.ptyId !== 'string' ||
          args.ptyId.length > MAX_PTY_ID_LENGTH ||
          args.ptyId.trim() !== args.ptyId ||
          args.ptyId.length === 0)) ||
      !agentHookServer.canTransferPaneAuthority(args.fromPaneKey, ptyId, ownership.ownsPty)
    ) {
      return
    }
    try {
      agentHookServer.transferPaneAuthority(args.fromPaneKey, args.toPaneKey, ptyId)
    } catch (err) {
      console.warn('[agent-hooks] transferPaneAuthority failed:', err)
    }
  })
}
