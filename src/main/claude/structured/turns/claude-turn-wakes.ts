// What woke Claude, read from its system task_notification frames: each names the run that finished
// by the call that started it (a resumed task's run has a new one). A turn Claude opens on its own
// names those runs, and a run that finishes into that turn joins them, so a wake-up that folds in
// another run's finish stops counting as the first run's alone.
import { taskAliasId, taskId } from '../../background-tasks/claude-background-task-frames'
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import type { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'

const MAX_WOKEN_BY = 16
const MAX_TASK_RUNS = 64
/** Past it the oldest is forgotten: its finish then names a run no conversation recorded. */
const MAX_STARTED_IN_TURN = 64

export class ClaudeTurnWakes {
  private pending: string[] = []
  /** A finish between turns that can't be named (no run id, or past the cap): the next wake-up names
   *  none, since naming the rest would leave it out. */
  private unnamed = false
  /** Runs the open turn started itself; their finish is that turn's own work, not a wake. */
  private readonly startedInTurn = new BoundedMap<string, true>({ maxEntries: MAX_STARTED_IN_TURN })
  /** Each started task's run: a shell's final update names only its task, and arrives first. */
  private readonly taskRuns = new BoundedMap<string, string>({ maxEntries: MAX_TASK_RUNS })

  /** Reads one provider frame; true when it changed the open turn's names (it names none once a
   *  finish into it can't be named). */
  observe(
    frame: Record<string, unknown>,
    turn: { wokenBy?: string[] } | null,
    calls: Pick<ClaudeToolOriginRegistry, 'childOwnerRef'>
  ): boolean {
    const task = taskId(frame)
    if (frame.type !== 'system' || !task) {
      return false
    }
    const run = taskAliasId(frame.tool_use_id)
    if (frame.subtype === 'task_started' && run) {
      this.started(task, run, !!turn)
    }
    // A background shell's end opens its wake-up with this update, just before its notification.
    if (frame.subtype === 'task_updated' && !turn) {
      const status = terminalStatus(frame.patch)
      const updated = this.taskRuns.get(task)
      if (status && updated) {
        this.queue(isStop(status) ? undefined : updated)
      }
      return false
    }
    if (frame.subtype !== 'task_notification') {
      return false
    }
    const stopped = isStop(frame.status)
    if (!turn) {
      this.queue(stopped ? undefined : run)
      return false
    }
    if (stopped && turn.wokenBy) {
      delete turn.wokenBy
      return true
    }
    const { wokenBy } = turn
    // A subagent's own task reports to it, not to the root's wake-up.
    const ownRun = run && (this.startedInTurn.delete(run) || wokenBy?.includes(run))
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

  private started(task: string, run: string, inTurn: boolean): void {
    if (inTurn) {
      this.startedInTurn.set(run, true)
    }
    this.taskRuns.set(task, run)
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

/** A stop may be Orca's (its Stop), so a stopped run's wake-up is no one's. */
function isStop(status: unknown): boolean {
  return status === 'stopped' || status === 'killed'
}

function terminalStatus(patch: unknown): string | undefined {
  const status = patch && typeof patch === 'object' && 'status' in patch ? patch.status : undefined
  return status === 'completed' || status === 'failed' || isStop(status)
    ? String(status)
    : undefined
}
