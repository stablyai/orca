import { RuntimePtyExitWorkerObservation } from './pty-exit-worker-observation'
import type { TerminalModelWait } from '../../../agent-hooks/server/server-model-wait'
import {
  claudeCompactingOnScreen,
  claudeModelWaitLastSeen,
  claudeReplyScreen,
  claudeToolRunsOnScreen,
  claudeTurnDoneOnScreen
} from '../wait/claude-model-wait-screen'
import { readClaudeToolReturnWithoutRequest } from '../../../claude/transcripts/claude-tool-return-without-request'
import {
  reportWorkerModelWait,
  WORKER_MODEL_WAIT_MS
} from '../../orchestration/workers/turn-stops/worker-model-wait-report'
import type { WorkerTurnStopDispatch } from '../../orchestration/workers/turn-stops/worker-turn-stop-report'

// Claude draws a streaming reply a line at a time: a slow stream (rig: about 3 tokens a second)
// drew no new line within 4 s, so the second look waits long enough for one.
const SCREEN_RECHECK_MS = 20_000

/** A terminal Claude worker whose hooks went quiet in model time: its screen says whether a reply is
 *  still arriving. True keeps the stopwatch running. */
export abstract class RuntimeTerminalWorkerModelWait extends RuntimePtyExitWorkerObservation {
  async observeWorkerModelWait(paneKey: string, wait: TerminalModelWait): Promise<boolean> {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    const ptyId = handle ? this.resolveLeafForHandle(handle)?.ptyId : undefined
    if (!handle || !ptyId || !this.modelWaitTarget(handle, paneKey)) {
      return false
    }
    // Streaming only if both looks saw the reply grow: one redraw (Claude restarting a stalled
    // request redraws its status) changes the screen once, a reply keeps changing it.
    const looks: (readonly string[] | null)[] = [this.readLiveTerminalScreenLines(ptyId)]
    for (let look = 1; look < 3; look++) {
      await new Promise((resolve) => setTimeout(resolve, SCREEN_RECHECK_MS))
      looks.push(this.readLiveTerminalScreenLines(ptyId))
    }
    const [first, middle, after] = looks
    // An unreadable screen (a pending hydration) proves nothing either way: look again next time.
    if (!first || !middle || !after || (grew(first, middle) && grew(middle, after))) {
      return true
    }
    // A hook during the look (a tool call that just arrived) restarted the stopwatch, and a turn
    // Claude shows as done waits on nothing.
    if (!wait.stillWaiting() || claudeTurnDoneOnScreen(after)) {
      return true
    }
    if (wait.toolMaybeOpen && claudeToolRunsOnScreen(after)) {
      wait.toolSeenRunning()
      return true
    }
    const toolReturnedAt = await toolReturnWithoutRequest(wait, after)
    // A hook during the read restarted the stopwatch: this stretch is over.
    if (!wait.stillWaiting()) {
      return true
    }
    // Re-read: the Dispatch may have settled while the screen and transcript were read.
    const db = this._orchestrationDb
    const target = this.modelWaitTarget(handle, paneKey)
    if (db && target) {
      const lastSeen = claudeModelWaitLastSeen(after)
      reportWorkerModelWait(
        db,
        target,
        {
          from: handle,
          kind: 'waiting',
          stretchKey: `${wait.turnKey}:${wait.since}`,
          waitedMs: Date.now() - wait.since,
          ...(lastSeen ? { lastSeen } : {}),
          ...(toolReturnedAt !== null ? { toolReturnedAt } : {})
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

/** When the last tool returned, only if the transcript shows no request since, for the whole wait. */
async function toolReturnWithoutRequest(
  wait: TerminalModelWait,
  screen: readonly string[]
): Promise<number | null> {
  if (!wait.transcriptPath || claudeCompactingOnScreen(screen) || !wait.firstTranscriptLook()) {
    return null
  }
  return readClaudeToolReturnWithoutRequest({
    transcriptPath: wait.transcriptPath,
    quietMs: WORKER_MODEL_WAIT_MS,
    stillWanted: wait.stillWaiting
  })
}

function grew(before: readonly string[], after: readonly string[]): boolean {
  return claudeReplyScreen(before) !== claudeReplyScreen(after)
}
