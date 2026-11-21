import { RuntimePtyExitWorkerObservation } from './pty-exit-worker-observation'
import type { TerminalModelWait } from '../../../agent-hooks/server/server-model-wait'
import {
  claudeModelWaitLastSeen,
  claudeReplyScreen,
  claudeToolRunsOnScreen
} from '../wait/claude-model-wait-screen'
import { reportWorkerModelWait } from '../../orchestration/workers/turn-stops/worker-model-wait-report'
import type { WorkerTurnStopDispatch } from '../../orchestration/workers/turn-stops/worker-turn-stop-report'

// Long enough for a streaming reply to draw a new line, short enough to stay one look.
const SCREEN_RECHECK_MS = 4_000

/** A terminal Claude worker whose hooks went quiet in model time: its screen says whether a reply is
 *  still arriving. True keeps the stopwatch running. */
export abstract class RuntimeTerminalWorkerModelWait extends RuntimePtyExitWorkerObservation {
  async observeWorkerModelWait(paneKey: string, wait: TerminalModelWait): Promise<boolean> {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    const ptyId = handle ? this.resolveLeafForHandle(handle)?.ptyId : undefined
    if (!handle || !ptyId || !this.modelWaitTarget(handle, paneKey)) {
      return false
    }
    const before = this.readLiveTerminalScreenLines(ptyId)
    await new Promise((resolve) => setTimeout(resolve, SCREEN_RECHECK_MS))
    const after = this.readLiveTerminalScreenLines(ptyId)
    if (before && after && claudeReplyScreen(before) !== claudeReplyScreen(after)) {
      return true
    }
    if (wait.toolMaybeOpen && after && claudeToolRunsOnScreen(after)) {
      return true
    }
    // Re-read: the Dispatch may have settled while the screen was read.
    const db = this._orchestrationDb
    const target = this.modelWaitTarget(handle, paneKey)
    if (db && target) {
      const lastSeen = after ? claudeModelWaitLastSeen(after) : undefined
      reportWorkerModelWait(
        db,
        target,
        {
          from: handle,
          kind: 'waiting',
          stretchKey: `${wait.turnKey}:${wait.since}`,
          waitedMs: Date.now() - wait.since,
          ...(lastSeen ? { lastSeen } : {})
        },
        this.workerTurnStopReportDeps
      )
    }
    return true
  }

  /** The pane's open Dispatch, local or at its Run home; a start still deciding reports itself. */
  private modelWaitTarget(handle: string, paneKey: string): WorkerTurnStopDispatch | null {
    const db = this._orchestrationDb
    const dispatch = db?.getActiveDispatchForTerminal(handle, paneKey)
    if (db && dispatch) {
      const state = db.getWorkerDispatch(dispatch.id)?.state
      return state === 'starting' || state === 'start_unknown' ? null : { kind: 'local', dispatch }
    }
    const attachment = db?.findActiveRemoteAttachmentForPane(paneKey)
    return attachment && attachment.state !== 'starting' && attachment.state !== 'start_unknown'
      ? { kind: 'remote', attachment }
      : null
  }
}
