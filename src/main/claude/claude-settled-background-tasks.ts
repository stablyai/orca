// The tracked background-task row: its type, how a later frame folds into one,
// how it projects onto the wire, and the retention state for rows that have
// reached a terminal edge.
//
// The real producer settles a task in two steps inside one tick:
// `background_tasks_changed` arrives FIRST with the task already absent, then
// `task_updated` / `task_notification` carry the outcome. So the terminal edge
// must be able to settle a task the live roster no longer holds — that is what
// `rememberRemoved` preserves. A removal whose outcome frame never arrives
// simply vanishes: removed tasks are never rendered and never guessed into a
// finished state.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../shared/agent-session-wire'
import { taskName, taskUsageTotalTokens } from './claude-background-task-frames'

const MAX_RETAINED_TASKS = 256

export type TrackedClaudeBackgroundTask = {
  backgrounded: boolean
  /** Foreground work is turn-scoped: the provider's `result` (or the next turn
   *  starting) is its outcome, so it stays visible only until that frame.
   *  Backgrounded work ignores this and is retired only by its own edge. */
  liveInTurn: boolean
  kind: AgentSessionBackgroundTask['kind']
  description?: string
  name?: string
  state?: AgentSessionBackgroundTaskRunState
  /** First-observed epoch ms; preserved across updates and roster replacement
   *  so clients can render elapsed and keep a stable first-seen sort. */
  startedAt: number
  /** Last epoch ms this task's OWN activity was observed. Moves on every frame
   *  that proves it alive, which is exactly what `startedAt` must not do. */
  evidenceObservedAt?: number
  totalTokens?: number
}

/** Fold a later lifecycle frame into a tracked row. The first-observed stamp
 *  never moves; `evidenceObservedAt` moves whenever the frame carried one. That
 *  divergence is the whole reason the two clocks are separate fields. */
export function mergeTrackedClaudeBackgroundTask(
  existing: TrackedClaudeBackgroundTask,
  next: Omit<TrackedClaudeBackgroundTask, 'liveInTurn'>
): TrackedClaudeBackgroundTask {
  return {
    backgrounded: existing.backgrounded || next.backgrounded,
    // A settled foreground task is not revived by a late edge frame.
    liveInTurn: existing.liveInTurn,
    kind: next.kind !== 'unknown' ? next.kind : existing.kind,
    description: next.description ?? existing.description,
    name: next.name ?? existing.name,
    state: next.state ?? existing.state,
    startedAt: existing.startedAt,
    evidenceObservedAt: next.evidenceObservedAt ?? existing.evidenceObservedAt,
    totalTokens: existing.totalTokens
  }
}

/** Fold a `task_progress` frame into a live row. The frame's ARRIVAL is the
 *  evidence — it proves the task is alive even carrying no usage, and it is the
 *  only per-task liveness signal a backgrounded task emits. Its `description` is
 *  the current activity ("Running <tool>") and never becomes the task's name. */
export function applyClaudeTaskProgressFrame(
  existing: TrackedClaudeBackgroundTask,
  message: Record<string, unknown>,
  observedAt: number
): TrackedClaudeBackgroundTask {
  const totalTokens = taskUsageTotalTokens(message)
  return {
    ...existing,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    name: existing.name ?? taskName(message),
    evidenceObservedAt: observedAt
  }
}

export function claudeBackgroundTaskDetail(
  id: string,
  task: TrackedClaudeBackgroundTask
): AgentSessionBackgroundTask {
  return {
    id,
    kind: task.kind,
    ...(task.description ? { description: task.description } : {}),
    ...(task.name ? { name: task.name } : {}),
    state: task.state ?? (task.kind === 'monitor' ? 'monitoring' : 'working'),
    startedAt: task.startedAt,
    ...(task.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: task.evidenceObservedAt }
      : {}),
    ...(task.totalTokens !== undefined ? { totalTokens: task.totalTokens } : {}),
    // Only a backgrounded row has a stop the host can target; absent means yes.
    ...(task.backgrounded ? {} : { stoppable: false })
  }
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_RETAINED_TASKS) {
    const oldest = map.keys().next()
    if (!oldest.done) {
      map.delete(oldest.value)
    }
  }
}

export class ClaudeSettledBackgroundTasks {
  private readonly settled = new Map<string, AgentSessionBackgroundTask>()
  private readonly recentlyRemoved = new Map<string, TrackedClaudeBackgroundTask>()

  /** An aggregate roster evicted a still-live backgrounded task; hold its
   *  details so the outcome frame trailing in the same tick can settle it. */
  rememberRemoved(id: string, task: TrackedClaudeBackgroundTask): void {
    setBounded(this.recentlyRemoved, id, task)
  }

  /** Terminal edge for `id`. `liveSource` is the live roster's entry when it
   *  still has one; otherwise the recently-removed copy is consumed. A second
   *  edge (updated, then notification) re-derives the settled state and can
   *  add the final usage the first edge lacked. */
  settle(
    id: string,
    state: AgentSessionBackgroundTaskRunState,
    outcome: { totalTokens?: number },
    liveSource: TrackedClaudeBackgroundTask | undefined
  ): void {
    const source = liveSource ?? this.recentlyRemoved.get(id)
    const already = this.settled.get(id)
    if (source?.backgrounded) {
      setBounded(this.settled, id, {
        ...claudeBackgroundTaskDetail(id, {
          ...source,
          totalTokens: outcome.totalTokens ?? source.totalTokens
        }),
        state
      })
    } else if (already) {
      this.settled.set(id, {
        ...already,
        state,
        ...(outcome.totalTokens !== undefined ? { totalTokens: outcome.totalTokens } : {})
      })
    }
    this.recentlyRemoved.delete(id)
  }

  /** Positive live evidence transfers identity back to the tracker, never the old outcome. */
  resume(id: string): TrackedClaudeBackgroundTask | undefined {
    const settled = this.settled.get(id)
    const removed = this.recentlyRemoved.get(id)
    this.settled.delete(id)
    this.recentlyRemoved.delete(id)
    const source = settled ?? removed
    if (!source || source.startedAt === undefined) {
      return undefined
    }
    // Positive live evidence, so it re-enters live in this turn too; a resumed
    // task is always backgrounded, which is what actually gates its visibility.
    return {
      ...source,
      backgrounded: true,
      liveInTurn: true,
      state: undefined,
      startedAt: source.startedAt
    }
  }

  get hasSettled(): boolean {
    return this.settled.size > 0
  }

  settledDetails(): AgentSessionBackgroundTask[] {
    return [...this.settled.values()]
  }

  /** Settled context only makes sense beside live work; the strip exits at the
   *  same instant it always has — when the last live task ends. */
  flushSettled(): void {
    this.settled.clear()
  }

  clear(): void {
    this.settled.clear()
    this.recentlyRemoved.clear()
  }
}
