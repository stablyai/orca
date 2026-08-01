import { ipcMain } from 'electron'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState, WorkspaceSessionState } from '../../shared/types'
import type { Store } from '../persistence'

const RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL = 'app:persist-before-unload-sync'
const MAX_RENDERER_SHUTDOWN_SESSION_PARTITIONS = 128
let trustedRendererShutdownCheckpointWebContentsId: number | null = null

type PersistBeforeUnloadSyncEnvelope = {
  sessions: unknown[]
  ui: Partial<PersistedUIState>
}

type RendererShutdownSessionPartition = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isOptionalRecordOf(value: unknown, isEntry: (entry: unknown) => boolean): boolean {
  return value === undefined || (isPlainRecord(value) && Object.values(value).every(isEntry))
}

function isWorkspaceSessionCheckpoint(value: unknown): value is WorkspaceSessionState {
  if (!isPlainRecord(value)) {
    return false
  }
  return (
    isNullableString(value.activeRepoId) &&
    isNullableString(value.activeWorktreeId) &&
    isNullableString(value.activeTabId) &&
    // Why: one-level container checks so a renderer serialization bug cannot
    // flush scalar garbage where hydration expects tab arrays and layout
    // records; the trusted sender bounds how deep validation needs to go.
    // Host-split slices legitimately omit a container that has no routed
    // entries, so an absent container is valid — only a present one is checked.
    isOptionalRecordOf(
      value.tabsByWorktree,
      (tabs) => Array.isArray(tabs) && tabs.every(isPlainRecord)
    ) &&
    isOptionalRecordOf(value.terminalLayoutsByTabId, isPlainRecord)
  )
}

function isExecutionHostId(value: unknown): value is ExecutionHostId | undefined {
  return (
    value === undefined || (typeof value === 'string' && parseExecutionHostId(value)?.id === value)
  )
}

function isPersistBeforeUnloadSyncEnvelope(
  value: unknown
): value is PersistBeforeUnloadSyncEnvelope {
  return (
    isPlainRecord(value) &&
    Array.isArray(value.sessions) &&
    value.sessions.length <= MAX_RENDERER_SHUTDOWN_SESSION_PARTITIONS &&
    isPlainRecord(value.ui)
  )
}

function isRendererShutdownSessionPartition(
  value: unknown
): value is RendererShutdownSessionPartition {
  return (
    isPlainRecord(value) &&
    isWorkspaceSessionCheckpoint(value.state) &&
    isExecutionHostId(value.hostId)
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
    if (!isPersistBeforeUnloadSyncEnvelope(args)) {
      event.returnValue = { ok: false }
      return
    }

    let ok = true
    // Why: stage both renderer-owned snapshots before synchronously flushing
    // the stores, so an immediate exit cannot outrun either update.
    try {
      for (const session of args.sessions) {
        // Why: skip, not reject — one malformed partition must not discard the
        // other hosts' checkpoints or leave the window unable to quit; the
        // skipped host keeps its last debounced write instead.
        if (!isRendererShutdownSessionPartition(session)) {
          const hostId = isPlainRecord(session) ? session.hostId : undefined
          console.error(
            '[app] Skipping malformed renderer shutdown checkpoint partition:',
            typeof hostId === 'string' ? hostId : 'local'
          )
          continue
        }
        store.setWorkspaceSession(session.state, session.hostId)
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
