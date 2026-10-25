// Roster removal can precede the outcome frame; retain identity without inventing a finished state.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../shared/agent-session-wire'

const MAX_RETAINED_TASKS = 256

export type TrackedClaudeBackgroundTask = {
  backgrounded: boolean
  /** Foreground work expires at result or next turn; background work waits for its own terminal edge. */
  liveInTurn: boolean
  kind: AgentSessionBackgroundTask['kind']
  description?: string
  name?: string
  state?: AgentSessionBackgroundTaskRunState
  /** First-observed epoch ms, retained across updates for elapsed time and stable sorting. */
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
    ...(task.totalTokens !== undefined ? { totalTokens: task.totalTokens } : {}),
    // Only a backgrounded row has a stop the host can target; absent means yes.
    ...(task.backgrounded ? {} : { stoppable: false })
  }
}

export function claudeBackgroundTaskDetails(
  tasks: ReadonlyMap<string, TrackedClaudeBackgroundTask>
): AgentSessionBackgroundTask[] {
  const details: AgentSessionBackgroundTask[] = []
  for (const [id, task] of tasks) {
    if (task.backgrounded || task.liveInTurn) {
      details.push(claudeBackgroundTaskDetail(id, task))
    }
  }
  return details
}

export function hasLiveClaudeBackgroundWork(tasks: Iterable<TrackedClaudeBackgroundTask>): boolean {
  for (const task of tasks) {
    if (task.backgrounded) {
      return true
    }
  }
  return false
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

  /** Retain removed task details for a trailing outcome frame. */
  rememberRemoved(id: string, task: TrackedClaudeBackgroundTask): void {
    setBounded(this.recentlyRemoved, id, task)
  }

  /** Use retained identity after roster removal; later terminal edges can refine state and usage. */
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

  // Keep settled context only while other work remains live.
  flushSettled(): void {
    this.settled.clear()
  }

  clear(): void {
    this.settled.clear()
    this.recentlyRemoved.clear()
  }
}
