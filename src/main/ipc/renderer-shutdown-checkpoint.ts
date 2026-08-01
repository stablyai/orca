import { ipcMain } from 'electron'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState, WorkspaceSessionState } from '../../shared/types'
import type { Store } from '../persistence'

const RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL = 'app:persist-before-unload-sync'
const MAX_RENDERER_SHUTDOWN_SESSION_PARTITIONS = 128
let trustedRendererShutdownCheckpointWebContentsId: number | null = null

type PersistBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isWorkspaceSessionCheckpoint(value: unknown): value is WorkspaceSessionState {
  if (!isPlainRecord(value)) {
    return false
  }
  return (
    isNullableString(value.activeRepoId) &&
    isNullableString(value.activeWorktreeId) &&
    isNullableString(value.activeTabId) &&
    isPlainRecord(value.tabsByWorktree) &&
    // Why: one-level container checks so a renderer serialization bug cannot
    // flush scalar garbage where hydration expects tab arrays and layout
    // records; the trusted sender bounds how deep validation needs to go.
    Object.values(value.tabsByWorktree).every(
      (tabs) => Array.isArray(tabs) && tabs.every(isPlainRecord)
    ) &&
    isPlainRecord(value.terminalLayoutsByTabId) &&
    Object.values(value.terminalLayoutsByTabId).every(isPlainRecord)
  )
}

function isExecutionHostId(value: unknown): value is ExecutionHostId | undefined {
  return (
    value === undefined || (typeof value === 'string' && parseExecutionHostId(value)?.id === value)
  )
}

function isPersistBeforeUnloadSyncArgs(value: unknown): value is PersistBeforeUnloadSyncArgs {
  if (!isPlainRecord(value) || !Array.isArray(value.sessions) || !isPlainRecord(value.ui)) {
    return false
  }
  if (value.sessions.length > MAX_RENDERER_SHUTDOWN_SESSION_PARTITIONS) {
    return false
  }
  return value.sessions.every(
    (session) =>
      isPlainRecord(session) &&
      isWorkspaceSessionCheckpoint(session.state) &&
      isExecutionHostId(session.hostId)
  )
}

function isTrustedRendererSender(
  sender: Electron.WebContents | undefined,
  trustedRendererWebContentsId: number | null
): boolean {
  return Boolean(
    sender &&
    !sender.isDestroyed() &&
    sender.getType() === 'window' &&
    sender.id === trustedRendererWebContentsId
  )
}

export function setTrustedRendererShutdownCheckpointWebContentsId(
  webContentsId: number | null
): void {
  trustedRendererShutdownCheckpointWebContentsId = webContentsId
}

export function registerRendererShutdownCheckpointHandler(store: Store): void {
  ipcMain.removeAllListeners(RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL)
  ipcMain.on(RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL, (event, args: unknown) => {
    if (!isTrustedRendererSender(event.sender, trustedRendererShutdownCheckpointWebContentsId)) {
      event.returnValue = { ok: false }
      return
    }
    if (!isPersistBeforeUnloadSyncArgs(args)) {
      event.returnValue = { ok: false }
      return
    }

    let ok = true
    // Why: stage both renderer-owned snapshots before synchronously flushing
    // the stores, so an immediate exit cannot outrun either update.
    try {
      for (const { state, hostId } of args.sessions) {
        store.setWorkspaceSession(state, hostId)
      }
      store.updateUI(args.ui)
    } catch (error) {
      console.error('[app] Failed to stage renderer state before unload:', error)
      ok = false
    }
    // Why: the durable state and active-view sidecar are independent stores;
    // flush each even when the other one fails.
    try {
      store.flushOrThrow()
    } catch (error) {
      console.error('[app] Failed to flush durable state before unload:', error)
      ok = false
    }
    try {
      store.flushActiveViewPreferenceOrThrow()
    } catch (error) {
      console.error('[app] Failed to flush active-view preference before unload:', error)
      ok = false
    }
    event.returnValue = { ok }
  })
}
