import { ipcMain } from 'electron'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { isWslMoveWindowWriteHeld } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import { windowViewSaveForMain, type ReconnectFactsFor } from '../persistence/window-save-view'
import { reportWindowSaveDrift } from '../persistence/window-save-divergence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { formatShutdownCheckpointFailureReason } from '../../shared/renderer-shutdown-events'

type StageBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

export type QuitResumeRecordsFor = (session: WorkspaceSessionState) => SleepingAgentSessionRecord[]

/** Apply only captured resume-record changes to existing panes so later wakes remain intact. */
function withQuitSleepRecords(
  hostId: string | undefined,
  session: WorkspaceSessionState,
  records: readonly SleepingAgentSessionRecord[]
): WorkspaceSessionState {
  const byWorkspace = Map.groupBy(records, (record) => record.worktreeId)
  let current = session
  for (const [workspace, workspaceRecords] of byWorkspace) {
    const change = applyCommandToSession(
      normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID,
      current,
      {
        type: 'sleep',
        workspace,
        paneKeys: workspaceRecords.map((record) => record.paneKey),
        records: workspaceRecords,
        recordOnly: true
      }
    )
    current = change.session ?? current
  }
  return current
}

export type ShutdownCheckpointResult = { ok: boolean }

/** Matches the will-quit teardown budget so a stalled disk can't strand a restart. */
export const SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS = 20_000

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
  // Retry superseded staged writes without chasing unrelated mutations beyond the shutdown deadline.
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

/** Keep main's layout, merge window view/facts and apply main's quit capture. */
function stagedSessionForMain(
  store: Store,
  state: WorkspaceSessionState,
  hostId: ExecutionHostId | undefined,
  quitResumeRecordsFor: QuitResumeRecordsFor,
  reconnectFactsFor: ReconnectFactsFor | undefined
): WorkspaceSessionState {
  const session = store.getWorkspaceSession(hostId)
  const stored = withQuitSleepRecords(hostId, session, quitResumeRecordsFor(session))
  reportWindowSaveDrift(stored, state, hostId, 'shutdown-checkpoint')
  return windowViewSaveForMain(stored, state, hostId, reconnectFactsFor)
}

export function registerRendererShutdownCheckpointHandler(
  store: Store,
  quitResumeRecordsFor: QuitResumeRecordsFor = () => [],
  reconnectFactsFor?: ReconnectFactsFor
): void {
  // beforeunload cannot await; sync reply confirms staging while navigation paths separately join durability.
  let pendingCheckpoint: Promise<ShutdownCheckpointResult> = Promise.resolve({ ok: true })

  ipcMain.on('app:stage-before-unload-sync', (event, args: StageBeforeUnloadSyncArgs) => {
    let error: string | undefined
    try {
      // A window a WSL move rewrote under is stale; main reloads it and keeps what is on disk.
      const sessions = isWslMoveWindowWriteHeld() ? [] : args.sessions
      for (const { state, hostId } of sessions) {
        if (!isFrozenOrcadSourceSessionPartition(store, hostId)) {
          store.stageWorkspaceSessionBeforeUnload(
            ORCA_LAYOUT_OWNER_IS_MAIN
              ? stagedSessionForMain(store, state, hostId, quitResumeRecordsFor, reconnectFactsFor)
              : state,
            hostId
          )
        }
      }
      if (!isWslMoveWindowWriteHeld()) {
        store.updateUI(args.ui)
      }
    } catch (stagingError) {
      console.error('[app] Failed to stage renderer state before unload:', stagingError)
      // Main's console is not persisted in packaged builds; the renderer toast is the only place users see the cause.
      error = formatShutdownCheckpointFailureReason(stagingError)
    }
    pendingCheckpoint =
      error === undefined ? flushStagedStateWithDeadline(store) : Promise.resolve({ ok: false })
    event.returnValue = error === undefined ? { ok: true } : { ok: false, error }
  })

  ipcMain.handle(
    'app:await-before-unload-checkpoint',
    (): Promise<ShutdownCheckpointResult> => pendingCheckpoint
  )
}
