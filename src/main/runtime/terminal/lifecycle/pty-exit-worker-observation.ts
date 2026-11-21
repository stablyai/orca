import { RuntimePtyExitSurfaceReads } from './pty-exit-surface-reads'
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

/** A worker's terminal ending or losing its agent, told to the Dispatch it runs. */
export abstract class RuntimePtyExitWorkerObservation extends RuntimePtyExitSurfaceReads {
  /** Observe exits here, so a Dispatch settles without waiting for coordinator polling. */
  protected failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    cause: TerminalExitCause,
    lastOutput?: string
  ): void {
    const db = this._orchestrationDb
    if (!db) {
      return
    }
    const errorContext = describeTerminalExitCause(cause)
    // A person closing the pane leaves the task unowned; any other end is the agent's exit.
    const gone = isDeliberateTerminalExit(cause)
      ? { reason: 'lost' as const, cause: 'it was closed in Orca', lastOutput }
      : { reason: 'exited' as const, cause: errorContext, lastOutput }
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
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

  /** The agent process ended and the shell kept the PTY. Tell the Dispatch without closing the terminal (#45328). */
  protected noteProvenAgentProcessExit(ptyId: string): void {
    const db = this._orchestrationDb
    const surfaces: { handle: string | undefined; paneKey?: string }[] = [
      ...this.getLeavesForPty(ptyId).map((leaf) => ({
        handle: this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId)),
        paneKey: this.makeRuntimePaneKey(leaf)
      })),
      {
        handle: this.handleByPtyId.get(ptyId),
        paneKey: this.paneOfPty(this.ptysById.get(ptyId)).paneKey ?? undefined
      }
    ]
    const reason = 'The agent process ended while its terminal stayed open'
    try {
      surfaces.some(
        ({ handle, paneKey }) =>
          db !== null &&
          handle !== undefined &&
          observeTerminalWorkerExit(
            db,
            this.getRuntimeId(),
            {
              handle,
              paneKey,
              processIncarnation: this.getTerminalProcessIncarnation(handle),
              error: reason,
              options: {
                workerProcessExited: true,
                terminationReason: 'exited',
                workerStage: 'process_exited'
              },
              processExited: true,
              gone: {
                reason: 'exited',
                cause: `${reason}; its terminal is still open for inspection`,
                lastOutput: this.readPtyLastOutput(ptyId)
              }
            },
            this.workerTurnStopReportDeps
          )
      )
    } catch (error) {
      console.warn('[orchestration] failed to settle an agent that exited inside a live terminal', ptyId, error)
    }
  }

  /** Codex outlives a failed reconnect, so no PTY exit will ever settle its dispatch (#24791). */
  protected settleLostAgentSession(ptyId: string): void {
    const db = this._orchestrationDb
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
    const reason = 'Codex lost its app-server and could not reconnect; relaunch Codex to continue'
    try {
      surfaces.some(
        ({ handle, paneKey }) =>
          db !== null &&
          handle !== undefined &&
          observeTerminalWorkerExit(
            db,
            this.getRuntimeId(),
            {
              handle,
              paneKey,
              processIncarnation: this.getTerminalProcessIncarnation(handle),
              error: reason,
              // The terminal and worktree stay up for inspection; workerProcessExited bypasses the active-worker guard for this dead session.
              options: { workerProcessExited: true, workerStage: 'agent_session_lost' },
              processExited: false,
              gone: {
                reason: 'lost',
                cause: `${reason}; its terminal is still open for inspection`,
                lastOutput: this.readPtyLastOutput(ptyId)
              }
            },
            this.workerTurnStopReportDeps
          )
      )
    } catch (error) {
      console.warn('[orchestration] failed to settle a lost agent session', ptyId, error)
    }
  }

  /** The PTY's last lines, read while its record exists: an exit prunes it before any async read. */
  protected readPtyLastOutput(ptyId: string | null | undefined): string | undefined {
    return terminalLastOutput(ptyId ? this.ptysById.get(ptyId) : undefined)
  }
}
