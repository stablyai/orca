import { ipcMain } from 'electron'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import type { AgentStatusCacheIdentity } from '../../shared/agent-status-types'
import { parseLegacyNumericPaneKey } from '../../shared/stable-pane-id'
import {
  clearMigrationUnsupportedPtysByTabPrefix,
  clearMigrationUnsupportedPtysForPaneKey
} from '../agent-hooks/migration-unsupported-pty-state'
import { isValidAgentStatusDropTabId } from './agent-status-ipc-boundary'

/** Dismissal preserves live pane caches; confirmed exits must clear latches that could revive a stale working row. */
// Bound renderer-supplied batches to the visible-row scale.
const MAX_DROP_PERSISTED_BATCH = 5_000

export function registerAgentStatusRowTeardownIpcHandlers(): void {
  ipcMain.removeAllListeners('agentStatus:drop')
  ipcMain.removeAllListeners('agentStatus:dropPersisted')
  ipcMain.removeAllListeners('agentStatus:dropPersistedBatch')
  ipcMain.removeAllListeners('agentStatus:reconcileEndedProcess')
  ipcMain.removeAllListeners('agentStatus:dropByTabPrefix')

  ipcMain.on('agentStatus:drop', (_event, paneKey: unknown) => {
    if (
      typeof paneKey !== 'string' ||
      (!isValidPaneKey(paneKey) && parseLegacyNumericPaneKey(paneKey) === null)
    ) {
      return
    }
    try {
      // Dismiss the row without wiping prompt/tool caches needed by the still-live pane.
      agentHookServer.dropStatusEntry(paneKey)
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntry failed:', err)
    }
  })

  ipcMain.on('agentStatus:dropPersisted', (_event, request: unknown) => {
    if (!isValidAgentStatusCacheIdentity(request)) {
      return
    }
    try {
      if (agentHookServer.dropPersistedStatusEntry(request)) {
        clearMigrationUnsupportedPtysForPaneKey(request.paneKey)
      }
    } catch (err) {
      console.warn('[agent-hooks] dropPersistedStatusEntry failed:', err)
    }
  })

  ipcMain.on('agentStatus:dropPersistedBatch', (_event, request: unknown) => {
    if (!Array.isArray(request) || request.length > MAX_DROP_PERSISTED_BATCH) {
      return
    }
    const identities = request.filter(isValidAgentStatusCacheIdentity)
    if (identities.length === 0) {
      return
    }
    try {
      for (const paneKey of agentHookServer.dropPersistedStatusEntries(identities)) {
        clearMigrationUnsupportedPtysForPaneKey(paneKey)
      }
    } catch (err) {
      console.warn('[agent-hooks] dropPersistedStatusEntries failed:', err)
    }
  })

  ipcMain.on('agentStatus:reconcileEndedProcess', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      // Confirmed process exit must clear latches with the row (STA-4612).
      agentHookServer.reconcileEndedProcessForPaneKeys([paneKey], {
        // The shell still owns the PTY, so keep its usable resume identity.
        preserveResumeIdentity: true
      })
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] reconcileEndedProcessForPaneKeys failed:', err)
    }
  })

  ipcMain.on('agentStatus:dropByTabPrefix', (_event, tabId: unknown) => {
    if (!isValidAgentStatusDropTabId(tabId)) {
      return
    }
    try {
      agentHookServer.dropStatusEntriesByTabPrefix(tabId)
      clearMigrationUnsupportedPtysByTabPrefix(tabId)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntriesByTabPrefix failed:', err)
    }
  })
}

function isValidAgentStatusCacheIdentity(value: unknown): value is AgentStatusCacheIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const request = value as Record<string, unknown>
  return (
    typeof request.paneKey === 'string' &&
    isValidPaneKey(request.paneKey) &&
    typeof request.receivedAt === 'number' &&
    Number.isFinite(request.receivedAt) &&
    typeof request.stateStartedAt === 'number' &&
    Number.isFinite(request.stateStartedAt)
  )
}
