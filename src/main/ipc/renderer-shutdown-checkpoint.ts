import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'

type StageBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

export type ShutdownCheckpointResult = { ok: boolean; error?: string }

/** Matches the will-quit teardown budget so a stalled disk can't strand a restart. */
export const SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS = 20_000

function flushStagedStateWithDeadline(store: Store): Promise<ShutdownCheckpointResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<ShutdownCheckpointResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      console.error('[app] Timed out persisting staged renderer state')
      resolve({ ok: false, error: 'Timed out persisting staged renderer state' })
    }, SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)
  })
  // Why not drain to stable: Store retries a superseded staged write without
  // chasing unrelated live mutations, which the deadline would otherwise cut off.
  const flush = store
    .flushPendingOrThrowAsync({ signal: controller.signal, drainToStableGeneration: false })
    .then((): ShutdownCheckpointResult => ({ ok: true }))
    .catch((error): ShutdownCheckpointResult => {
      console.error('[app] Failed to persist staged renderer state:', error)
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
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

  ipcMain.on('app:stage-before-unload-sync', (event, args: StageBeforeUnloadSyncArgs) => {
    let ok = true
    let error: string | undefined

    for (const { state, hostId } of args.sessions) {
      try {
        store.stageWorkspaceSessionBeforeUnload(state, hostId)
      } catch (err) {
        console.error(
          `[app] Failed to stage workspace session before unload for host ${hostId ?? 'local'}:`,
          err
        )
        ok = false
        if (!error) {
          error = err instanceof Error ? err.message : String(err)
        }
      }
    }

    try {
      store.updateUI(args.ui)
    } catch (err) {
      console.warn('[app] Failed to update UI state before unload:', err)
    }

    pendingCheckpoint = ok
      ? flushStagedStateWithDeadline(store)
      : Promise.resolve({ ok: false, ...(error ? { error } : {}) })
    event.returnValue = { ok, ...(error ? { error } : {}) }
  })

  ipcMain.handle(
    'app:await-before-unload-checkpoint',
    (): Promise<ShutdownCheckpointResult> => pendingCheckpoint
  )
}
