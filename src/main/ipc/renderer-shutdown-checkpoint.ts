import { ipcMain } from 'electron'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'

const RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL = 'app:stage-before-unload-sync'
const MAX_RENDERER_SHUTDOWN_SESSION_PARTITIONS = 128
let trustedRendererShutdownCheckpointWebContentsId: number | null = null

type StageBeforeUnloadSyncEnvelope = {
  sessions: unknown[]
  ui: Partial<PersistedUIState>
}

type RendererShutdownSessionPartition = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

export type ShutdownCheckpointResult = { ok: boolean }

/** Matches the will-quit teardown budget so a stalled disk can't strand a restart. */
export const SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS = 20_000

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

function isStageBeforeUnloadSyncEnvelope(value: unknown): value is StageBeforeUnloadSyncEnvelope {
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

function flushStagedStateWithDeadline(store: Store): Promise<ShutdownCheckpointResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<ShutdownCheckpointResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      console.error('[app] Timed out persisting staged renderer state')
      resolve({ ok: false })
    }, SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)
  })
  // Why not drain to stable: Store retries a superseded staged write without
  // chasing unrelated live mutations, which the deadline would otherwise cut off.
  const flush = store
    .flushPendingOrThrowAsync({ signal: controller.signal, drainToStableGeneration: false })
    .then((): ShutdownCheckpointResult => ({ ok: true }))
    .catch((error): ShutdownCheckpointResult => {
      console.error('[app] Failed to persist staged renderer state:', error)
      return { ok: false }
    })
  return Promise.race([flush, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

export function registerRendererShutdownCheckpointHandler(store: Store): void {
  // Why: beforeunload cannot await, so the sync reply only reports staging.
  // Durability is joined out-of-band by paths that are about to navigate.
  let pendingCheckpoint: Promise<ShutdownCheckpointResult> = Promise.resolve({ ok: true })

  ipcMain.removeAllListeners(RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL)
  ipcMain.on(RENDERER_SHUTDOWN_CHECKPOINT_CHANNEL, (event, args: unknown) => {
    if (!isTrustedRendererSender(event.sender, trustedRendererShutdownCheckpointWebContentsId)) {
      event.returnValue = { ok: false }
      return
    }
    if (!isStageBeforeUnloadSyncEnvelope(args)) {
      event.returnValue = { ok: false }
      return
    }

    let ok = true
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
        store.stageWorkspaceSessionBeforeUnload(session.state, session.hostId)
      }
      store.updateUI(args.ui)
    } catch (error) {
      console.error('[app] Failed to stage renderer state before unload:', error)
      ok = false
    }
    pendingCheckpoint = ok ? flushStagedStateWithDeadline(store) : Promise.resolve({ ok: false })
    event.returnValue = { ok }
  })

  ipcMain.handle(
    'app:await-before-unload-checkpoint',
    (): Promise<ShutdownCheckpointResult> => pendingCheckpoint
  )
}
