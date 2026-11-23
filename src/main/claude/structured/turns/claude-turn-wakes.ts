// What woke Claude, read from its system task_notification frames: each names the run that finished
// by the call that started it (a resumed task's run has a new one). A turn Claude opens on its own
// names those runs, and a run that finishes into that turn joins them, so a wake-up that folds in
// another run's finish stops counting as the first run's alone.
import { taskAliasId, taskId } from '../../background-tasks/claude-background-task-frames'
import type { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'

const MAX_WOKEN_BY = 16

export class ClaudeTurnWakes {
  private pending: string[] = []
  /** A finish between turns that can't be named (no run id, or past the cap): the next wake-up names
   *  none, since naming the rest would leave it out. */
  private unnamed = false
  /** Runs the open turn started itself; their finish is that turn's own work, not a wake. */
  private readonly startedInTurn = new Set<string>()

  /** Reads one provider frame; true when it changed the open turn's names (it names none once a
   *  finish into it can't be named). */
  observe(
    frame: Record<string, unknown>,
    turn: { wokenBy?: string[] } | null,
    calls: Pick<ClaudeToolOriginRegistry, 'childOwnerRef'>
  ): boolean {
    if (frame.type !== 'system' || !taskId(frame)) {
      return false
    }
    const run = taskAliasId(frame.tool_use_id)
    if (frame.subtype === 'task_started' && turn && run) {
      this.startedInTurn.add(run)
    }
    if (frame.subtype !== 'task_notification') {
      return false
    }
    if (!turn) {
      this.queue(run)
      return false
    }
    const { wokenBy } = turn
    // A subagent's own task reports to it, not to the root's wake-up.
    const ownRun = run && (wokenBy?.includes(run) || this.startedInTurn.has(run))
    if (!wokenBy || ownRun || (run && calls.childOwnerRef(run) !== null)) {
      return false
    }
    if (run && wokenBy.length < MAX_WOKEN_BY) {
      turn.wokenBy = [...wokenBy, run]
    } else {
      delete turn.wokenBy
    }
    return true
  }

  /** A message reached Claude between turns: the next wake-up is not only its runs'. */
  messaged(): void {
    this.unnamed = true
  }

  /** Taken by the turn that opens next: named only when Claude opened it, not a send. */
  take(opensItself: boolean): { wokenBy?: string[] } {
    const wokenBy = this.unnamed ? [] : this.pending
    this.pending = []
    this.unnamed = false
    this.startedInTurn.clear()
    return opensItself && wokenBy.length > 0 ? { wokenBy } : {}
  }

  private queue(run: string | undefined): void {
    if (run && this.pending.includes(run)) {
      return
    }
    if (run && this.pending.length < MAX_WOKEN_BY) {
      this.pending = [...this.pending, run]
    } else {
      this.unnamed = true
    }
  }
}
