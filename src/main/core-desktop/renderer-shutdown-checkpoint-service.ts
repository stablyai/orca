import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-resume'
import { applyCommandToSession } from '../persistence/terminal-topology/pane-admission/terminal-pane-admission'
import type { PersistedUIState } from '../../shared/orca-profiles/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { Store } from '../persistence/loading-store/store'
import { isFrozenOrcadSourceSessionPartition } from '../persistence/migrating-orcad-catalog/source/catalog/orcad-source-visibility'
import { isWslMoveWindowWriteHeld } from '../persistence/moving-wsl-projects/quiescence/wsl-move-window-write-hold'
import { windowViewSaveForMain, type ReconnectFactsFor } from '../persistence/window-save-view'
import { reportWindowSaveDrift } from '../persistence/window-save-divergence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import { formatShutdownCheckpointFailureReason } from '../../shared/app-lifecycle/shutdown/renderer-shutdown-events'
import type { DesktopRelayWrite } from '../../shared/workspace-session/desktop-relay-write'
import { windowSaveKeepingRelayOwnership } from '../persistence/window-save-relay-ownership'
import { applyDesktopRelayWrite } from '../../shared/workspace-session/desktop-relay-ownership'

export type RendererShutdownCapture = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
  /** A window that sends relay ids by ownership leaves them out of `sessions` and sends them here. */
  desktopRelays?: DesktopRelayWrite['hosts']
}

/** Each partition to stage with the window's relay ids applied by ownership, so both commit together. */
function sessionsWithDesktopRelays(
  store: Store,
  capture: RendererShutdownCapture
): { state: WorkspaceSessionState; hostId?: ExecutionHostId }[] {
  if (!capture.desktopRelays) {
    return capture.sessions.map(({ state, hostId }) => ({
      state: windowSaveKeepingRelayOwnership(store.getWorkspaceSession(hostId), state, 'set'),
      hostId
    }))
  }
  const relaysByHost = new Map(capture.desktopRelays.map((host) => [host.hostId, host]))
  const staged = capture.sessions.map(({ state, hostId }) => ({
    hostId,
    resolved: normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID,
    state: windowSaveKeepingRelayOwnership(store.getWorkspaceSession(hostId), state, 'set', {
      relays: 'separate'
    })
  }))
  // No legacy adoption here: the snapshot may move rows the stored partitions still place elsewhere.
  const withRelays = staged.map(({ state, hostId, resolved }) => {
    const relays = relaysByHost.get(resolved)
    const patch = relays && applyDesktopRelayWrite(state, relays, null).patch
    return { state: patch ? { ...state, ...patch } : state, hostId }
  })
  const stagedHosts = new Set(staged.map(({ resolved }) => resolved))
  const existing = new Set(store.getWorkspaceSessionHostIds())
  for (const [hostId, relays] of relaysByHost) {
    if (stagedHosts.has(hostId)) {
      continue
    }
    const stored = store.getWorkspaceSession(hostId)
    const { patch } = applyDesktopRelayWrite(stored, relays, null)
    // Never materialize a partition just to record that it holds nothing.
    if (patch && (existing.has(hostId) || patch.remoteSessionIdsByTabId)) {
      withRelays.push({ state: { ...stored, ...patch }, hostId })
    }
  }
  return withRelays
}

export type ShutdownCheckpointResult = { ok: boolean }

export type RendererCheckpointStage = {
  staged: { ok: true } | { ok: false; error: string }
  durable: Promise<ShutdownCheckpointResult>
}

export type RendererShutdownCheckpointService = {
  stage(capture: RendererShutdownCapture): RendererCheckpointStage
}

export type QuitResumeRecordsFor = (session: WorkspaceSessionState) => SleepingAgentSessionRecord[]

/** Matches the will-quit teardown budget so a stalled disk can't strand a restart. */
export const SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS = 20_000

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

/** Stages synchronously so beforeunload can answer; durability is joined separately. */
export function createRendererShutdownCheckpointService(
  store: Store,
  quitResumeRecordsFor: QuitResumeRecordsFor = () => [],
  reconnectFactsFor?: ReconnectFactsFor
): RendererShutdownCheckpointService {
  return {
    stage(capture) {
      try {
        // A window a WSL move rewrote under is stale; main reloads it and keeps what is on disk.
        const sessions = isWslMoveWindowWriteHeld() ? [] : sessionsWithDesktopRelays(store, capture)
        for (const { state, hostId } of sessions) {
          if (!isFrozenOrcadSourceSessionPartition(store, hostId)) {
            store.stageWorkspaceSessionBeforeUnload(
              ORCA_LAYOUT_OWNER_IS_MAIN
                ? stagedSessionForMain(
                    store,
                    state,
                    hostId,
                    quitResumeRecordsFor,
                    reconnectFactsFor
                  )
                : state,
              hostId
            )
          }
        }
        if (!isWslMoveWindowWriteHeld()) {
          store.updateUI(capture.ui)
        }
      } catch (stagingError) {
        console.error('[app] Failed to stage renderer state before unload:', stagingError)
        // Main's console is not persisted in packaged builds; the renderer toast is the only place users see the cause.
        return {
          staged: { ok: false, error: formatShutdownCheckpointFailureReason(stagingError) },
          durable: Promise.resolve({ ok: false })
        }
      }
      return { staged: { ok: true }, durable: flushStagedStateWithDeadline(store) }
    }
  }
}
