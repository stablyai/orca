// Retention state for background tasks that have reached a terminal edge.
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

const MAX_RETAINED_TASKS = 256

export type TrackedClaudeBackgroundTask = {
  backgrounded: boolean
  kind: AgentSessionBackgroundTask['kind']
  description?: string
  name?: string
  state?: AgentSessionBackgroundTaskRunState
  /** First-observed epoch ms; preserved across updates and roster replacement
   *  so clients can render elapsed and keep a stable first-seen sort. */
  startedAt: number
  totalTokens?: number
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
    ...(task.totalTokens !== undefined ? { totalTokens: task.totalTokens } : {})
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
    return { ...source, backgrounded: true, state: undefined, startedAt: source.startedAt }
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
