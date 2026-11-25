import { RuntimePtyExitSurfaceReads } from './pty-exit-surface-reads'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import {
  type TerminalExitCause,
  describeTerminalExitCause,
  isDeliberateTerminalExit
} from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import { terminalLastOutput } from '../output/tail/terminal-tail-read'
import {
  observeRemoteWorkerExit,
  observeTerminalWorkerExit
} from '../../orchestration/workers/lifecycle/worker-exit-observation'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { WorkerGone } from '../../orchestration/workers/turn-stops/worker-presence-report'
import { retireCoordinatorPaneRuns } from '../../orchestration/db/runs/retired-coordinator-runs'
import type { TerminalSurfaceCloseTarget } from '../../../../shared/workspace-layout/terminal-surfaces/terminal-surface-close-target'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'

/** A worker's terminal ending or losing its agent, told to the Dispatch it runs. */
export abstract class RuntimePtyExitWorkerObservation extends RuntimePtyExitSurfaceReads {
  /** Observe exits here, so a Dispatch settles without waiting for coordinator polling. */
  protected failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    cause: TerminalExitCause,
    lastOutput?: string,
    options: { paneRespawning?: boolean } = {}
  ): void {
    const db = this._orchestrationDb
    if (!db) {
      return
    }
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
    const fail = (): void =>
      this.observeWorkerTerminalExit(db, handle, paneKey, processIncarnation, cause, lastOutput)
    // Its pane is starting again where the window's restore resumes the conversation: the Dispatch waits for it.
    const respawning = options.paneRespawning && paneKey
    const dispatch = respawning ? db.getActiveDispatchForTerminal(handle, paneKey) : undefined
    if (
      respawning &&
      dispatch &&
      this.terminalWorkerRestartResume.holdInPlace(
        dispatch.id,
        respawning,
        processIncarnation,
        fail
      )
    ) {
      return
    }
    fail()
  }

  /** A coordinator terminal that ended with nothing left in its pane: its Runs have no reader. */
  protected retireExitedCoordinatorRuns(
    paneKeys: Iterable<string | null>,
    ptyId: string | null,
    exitIncarnationId: PtyIncarnationId | undefined
  ): void {
    try {
      // A restored terminal can end before anything opened the database its Runs are in.
      const db = this.getExistingOrchestrationDb()
      if (!db) {
        return
      }
      for (const paneKey of paneKeys) {
        if (paneKey && !this.paneHasSuccessorProcess(paneKey, ptyId, exitIncarnationId)) {
          retireCoordinatorPaneRuns(db, paneKey)
        }
      }
    } catch (error) {
      // The exit's cleanup goes on: its Runs stay bound, as before this retirement existed.
      console.warn('[orchestration] could not retire an ended terminal from its Runs', error)
    }
  }

  /** The panes a close removes, read before it does: a tab's every leaf, or the one pane. */
  protected terminalCloseLeafIds(worktreeId: string, target: TerminalSurfaceCloseTarget): string[] {
    if (target.kind === 'pane') {
      return [target.leafId]
    }
    const layout =
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId?.[target.tabId]
    const graphLeafIds = [...this.leaves.values()]
      .filter((leaf) => leaf.tabId === target.tabId)
      .map((leaf) => leaf.leafId)
    return [...new Set([...collectLeafIds(layout?.root), ...graphLeafIds])]
  }
  /** A closed pane whose leaf no layout holds any more and no live terminal shows: a slept or
   *  host-lost coordinator closes without an exit, so its close retires its Runs. */
  protected retireClosedCoordinatorPanes(
    worktreeId: string,
    tabId: string,
    leafIds: readonly string[]
  ): void {
    const layouts = this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId ?? {}
    const remaining = new Set(
      Object.values(layouts).flatMap((layout) => collectLeafIds(layout?.root))
    )
    const gone = leafIds.filter((leafId) => !remaining.has(leafId))
    // A pane a live terminal still shows retires on that terminal's exit.
    this.retireExitedCoordinatorRuns(
      gone.map((leafId) => `${tabId}:${leafId}`),
      null,
      undefined
    )
  }

  private observeWorkerTerminalExit(
    db: OrchestrationDb,
    handle: string,
    paneKey: string | null,
    processIncarnation: string | null,
    cause: TerminalExitCause,
    lastOutput: string | undefined
  ): void {
    const errorContext = describeTerminalExitCause(cause)
    // A person closing the pane leaves the task unowned; any other end is the agent's exit.
    const gone = isDeliberateTerminalExit(cause)
      ? { reason: 'lost' as const, cause: 'it was closed in Orca', lastOutput }
      : { reason: 'exited' as const, cause: errorContext, lastOutput }
    const settledLocally = observeTerminalWorkerExit(
      db,
      this.getRuntimeId(),
      {
        handle,
        paneKey: paneKey ?? undefined,
        processIncarnation,
        error: errorContext,
        options: { workerProcessExited: true, terminationReason: cause.kind },
        processExited: true,
        gone
      },
      this.workerTurnStopReportDeps
    )
    if (!settledLocally && paneKey) {
      observeRemoteWorkerExit(
        db,
        { handle, paneKey, processIncarnation, gone },
        this.workerTurnStopReportDeps
      )
    }
  }

  /** Codex outlives a failed reconnect, so no PTY exit will ever settle its dispatch (#24791). */
  protected settleLostAgentSession(ptyId: string): void {
    const reason = 'Codex lost its app-server and could not reconnect; relaunch Codex to continue'
    this.settleEndedAgentSession(ptyId, {
      error: reason,
      workerStage: 'agent_session_lost',
      gone: { reason: 'lost', cause: `${reason}; its terminal is still open for inspection` }
    })
  }

  /** A pane's agent whose end the hook server proved (its process gone, its shell alone, or its
   *  own end hook) while its terminal stays open, so no PTY exit will tell its Dispatch. */
  observeWorkerAgentExit(paneKey: string): void {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    const ptyId = handle ? this.resolveLeafForHandle(handle)?.ptyId : undefined
    if (!ptyId) {
      return
    }
    this.retireStatusAfterProvenAgentExit(ptyId)
    this.settleEndedAgentSession(ptyId, {
      error: "The worker's agent exited",
      gone: { reason: 'exited', cause: 'its agent exited; its terminal is still open' },
      startDecides: true
    })
  }

  /** A foreground read taken while the agent was still quitting restored the status its cleared
   *  title had dropped; with the end proven, a title that reads as no agent drops it again. */
  private retireStatusAfterProvenAgentExit(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    const title = entry?.lastTitle
    if (!pty || !entry || !title || pty.lastAgentStatus === null) {
      return
    }
    const raw = pty.titleDisplayClear?.title ?? title.raw
    if (this.classifyPtyTitleStatus(ptyId, raw) !== null) {
      return
    }
    entry.tracker.forgetAgentStatus()
    if (this.applyTrackedPtyTitle(ptyId, raw, title.normalized, undefined, { statusOnly: true })) {
      this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }

  /** Settles the one Dispatch the PTY's worker runs, here or at its Run home; the process
   *  incarnation fences repeats of the same end. */
  private settleEndedAgentSession(
    ptyId: string,
    ending: {
      error: string
      workerStage?: string
      gone: Pick<WorkerGone, 'reason' | 'cause'>
      /** A start still deciding reports its own outcome; an agent in its pane before then may be another's. */
      startDecides?: true
    }
  ): void {
    const db = this._orchestrationDb
    if (!db) {
      return
    }
    const surfaces: { handle: string | undefined; paneKey?: string }[] = [
      ...this.getLeavesForPty(ptyId).map((leaf) => ({
        handle: this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId)),
        paneKey: this.makeRuntimePaneKey(leaf)
      })),
      // Pane identity survives handle reminting, as on the exit path.
      {
        handle: this.handleByPtyId.get(ptyId),
        paneKey: this.paneOfPty(this.ptysById.get(ptyId)).paneKey ?? undefined
      }
    ]
    const lastOutput = this.readPtyLastOutput(ptyId)
    try {
      for (const { handle, paneKey } of surfaces) {
        if (handle === undefined) {
          continue
        }
        const active = db.getActiveDispatchForTerminal(handle, paneKey)
        const attachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
        const state = active ? db.getWorkerDispatch(active.id)?.state : attachment?.state
        if (ending.startDecides && (state === 'starting' || state === 'start_unknown')) {
          return
        }
        const processIncarnation = this.getTerminalProcessIncarnation(handle)
        const gone = { ...ending.gone, lastOutput }
        const settled = observeTerminalWorkerExit(
          db,
          this.getRuntimeId(),
          {
            handle,
            paneKey,
            processIncarnation,
            error: ending.error,
            // The terminal and worktree stay up for inspection; workerProcessExited bypasses the active-worker guard for this ended session.
            options: {
              workerProcessExited: true,
              ...(ending.workerStage ? { workerStage: ending.workerStage } : {})
            },
            processExited: false,
            gone
          },
          this.workerTurnStopReportDeps
        )
        if (settled) {
          return
        }
        if (paneKey) {
          observeRemoteWorkerExit(
            db,
            { handle, paneKey, processIncarnation, gone },
            this.workerTurnStopReportDeps
          )
        }
      }
    } catch (error) {
      console.warn('[orchestration] failed to settle an ended agent session', ptyId, error)
    }
  }

  /** The PTY's last lines, read while its record exists: an exit prunes it before any async read. */
  protected readPtyLastOutput(ptyId: string | null | undefined): string | undefined {
    return terminalLastOutput(ptyId ? this.ptysById.get(ptyId) : undefined)
  }
}
