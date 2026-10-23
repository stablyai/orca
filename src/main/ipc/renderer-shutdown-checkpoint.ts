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
import { windowViewSaveForMain, type ReconnectFactsFor } from '../persistence/window-save-view'
import { reportWindowSaveDrift } from '../persistence/window-save-divergence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

type StageBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

/** Layout-owner builds: main's quit capture of the agents of the panes a partition holds. */
export type QuitResumeRecordsFor = (session: WorkspaceSessionState) => SleepingAgentSessionRecord[]

/**
 * The partition with the quit capture's resume records written, each workspace's through the
 * record-only sleep command a live capture sends: only what the capture changed, so a wake main
 * recorded stays. Records of panes the partition lacks change nothing.
 */
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

/**
 * Switch point: main keeps its own layout over the window's and takes its view and facts, with its
 * quit capture's resume records written into its own first.
 */
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
  // Why: beforeunload cannot await, so the sync reply only reports staging.
  // Durability is joined out-of-band by paths that are about to navigate.
  let pendingCheckpoint: Promise<ShutdownCheckpointResult> = Promise.resolve({ ok: true })

  ipcMain.on('app:stage-before-unload-sync', (event, args: StageBeforeUnloadSyncArgs) => {
    let ok = true
    try {
      for (const { state, hostId } of args.sessions) {
        if (!isFrozenOrcadSourceSessionPartition(store, hostId)) {
          store.stageWorkspaceSessionBeforeUnload(
            ORCA_LAYOUT_OWNER_IS_MAIN
              ? stagedSessionForMain(store, state, hostId, quitResumeRecordsFor, reconnectFactsFor)
              : state,
            hostId
          )
        }
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
