import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import {
  classifyClaudeBackgroundTaskKind,
  liveClaudeTaskRunState,
  record,
  taskDescription,
  taskId,
  taskName,
  taskUsageTotalTokens,
  terminalClaudeTaskRunState
} from './claude-background-task-frames'
import {
  ClaudeSettledBackgroundTasks,
  claudeBackgroundTaskDetail,
  type TrackedClaudeBackgroundTask
} from './claude-settled-background-tasks'

// `claude-subagent-*` reads this channel through these names; the readers themselves
// live in the frames module so both consumers share one definition.
export {
  classifyClaudeBackgroundTaskKind,
  isBoundedClaudeTaskId,
  taskDescription as claudeTaskDescription,
  taskId as claudeTaskId
} from './claude-background-task-frames'
export type { ClaudeBackgroundTaskKind } from './claude-background-task-frames'

const MAX_TRACKED_TASKS = 256

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedClaudeBackgroundTask>()
  private readonly retention = new ClaudeSettledBackgroundTasks()
  private readonly terminalTaskIds = new Set<string>()
  private aggregateRosterObserved = false
  private monitoring = false
  private publishedTasksFingerprint = ''

  constructor(private readonly now: () => number = () => Date.now()) {}

  get state(): AgentSessionBackgroundTaskState | null {
    if (!this.monitoring) {
      return null
    }
    return {
      state: 'monitoring',
      tasks: this.backgroundTaskDetails(),
      ...(this.retention.hasSettled ? { settledTasks: this.retention.settledDetails() } : {})
    }
  }

  get stoppableTaskIds(): string[] {
    const ids: string[] = []
    for (const [id, task] of this.tasks) {
      if (task.backgrounded) {
        ids.push(id)
      }
    }
    return ids
  }

  observe(message: Record<string, unknown>, startsTurn = false): boolean {
    // Background work publishes through a foreground turn: the strip stays
    // honest mid-fan-out and the client alone decides when the idle-only
    // monitoring label may speak.
    if (message.type === 'system') {
      if (!this.observeSystemFrame(message) && !startsTurn) {
        return false
      }
    } else if (!startsTurn && message.type !== 'result') {
      return false
    }
    return this.refreshMonitoring()
  }

  clear(): boolean {
    this.tasks.clear()
    this.retention.clear()
    this.terminalTaskIds.clear()
    this.aggregateRosterObserved = false
    return this.refreshMonitoring()
  }

  private settle(
    id: string,
    state: AgentSessionBackgroundTaskRunState,
    outcome: { totalTokens?: number } = {}
  ): void {
    this.retention.settle(id, state, outcome, this.tasks.get(id))
    this.finish(id)
  }

  private observeSystemFrame(message: Record<string, unknown>): boolean {
    if (message.subtype === 'background_tasks_changed') {
      this.replaceAggregateRoster(message.tasks)
      return true
    }
    const id = taskId(message)
    if (!id) {
      return false
    }
    if (message.subtype === 'task_notification') {
      // The notification is affirmative terminal evidence even when its status
      // field is unreadable — matching the liveness semantics this edge always had.
      this.settle(id, terminalClaudeTaskRunState(message.status) ?? 'done', {
        totalTokens: taskUsageTotalTokens(message)
      })
      return true
    }
    if (message.subtype === 'task_progress') {
      // Progress `description` is the current activity ("Running <tool>"), not
      // the task's name — only usage (and a missing identity) may update.
      const existing = this.tasks.get(id)
      const totalTokens = taskUsageTotalTokens(message)
      if (!existing?.backgrounded || totalTokens === undefined) {
        return false
      }
      this.tasks.set(id, { ...existing, totalTokens, name: existing.name ?? taskName(message) })
      return true
    }
    if (message.subtype === 'task_updated') {
      return this.observeTaskUpdated(id, message)
    }
    if (message.subtype !== 'task_started' || this.terminalTaskIds.has(id)) {
      return false
    }
    if (message.ambient === true || message.skip_transcript === true) {
      this.finish(id)
      return true
    }
    if (this.aggregateRosterObserved && !this.tasks.has(id)) {
      return false
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    this.upsert(id, {
      backgrounded: message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor',
      kind,
      description: taskDescription(message.description),
      name: taskName(message),
      state: liveClaudeTaskRunState(message.status) ?? undefined,
      startedAt: this.now()
    })
    return true
  }

  private observeTaskUpdated(id: string, message: Record<string, unknown>): boolean {
    const patch = record(message.patch)
    if (!patch) {
      return false
    }
    const settledState = terminalClaudeTaskRunState(patch.status)
    if (settledState) {
      this.settle(id, settledState)
      return true
    }
    const existing = this.tasks.get(id)
    // Classification is re-derived per transition: a later frame that reveals a
    // real type moves the task between buckets instead of pinning first-seen.
    const patchKind =
      'task_type' in patch ? classifyClaudeBackgroundTaskKind(patch.task_type) : undefined
    const liveState = liveClaudeTaskRunState(patch.status)
    const hasContent =
      patch.is_backgrounded === true ||
      taskDescription(patch.description) !== undefined ||
      taskName(patch) !== undefined ||
      liveState !== null ||
      (patchKind !== undefined && patchKind !== 'unknown')
    if (hasContent && (!this.aggregateRosterObserved || existing)) {
      this.upsert(id, {
        backgrounded: patch.is_backgrounded === true || existing?.backgrounded === true,
        kind: patchKind ?? existing?.kind ?? 'unknown',
        description: taskDescription(patch.description),
        name: taskName(patch),
        state: liveState ?? undefined,
        startedAt: this.now()
      })
      return true
    }
    return false
  }

  private replaceAggregateRoster(value: unknown): void {
    if (!Array.isArray(value)) {
      return
    }
    const prior = new Map(this.tasks)
    this.aggregateRosterObserved = true
    this.tasks.clear()
    this.terminalTaskIds.clear()
    for (const valueTask of value) {
      if (this.tasks.size >= MAX_TRACKED_TASKS) {
        break
      }
      const task = record(valueTask)
      if (!task || task.ambient === true) {
        continue
      }
      const id = taskId(task)
      if (!id) {
        continue
      }
      // An authoritative live roster supersedes an earlier terminal edge.
      const retained = this.retention.resume(id)
      const existing = prior.get(id) ?? retained
      const kind = classifyClaudeBackgroundTaskKind(task.task_type)
      this.tasks.set(id, {
        backgrounded: true,
        kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
        description: taskDescription(task.description) ?? existing?.description,
        name: taskName(task) ?? existing?.name,
        state: liveClaudeTaskRunState(task.status) ?? existing?.state,
        startedAt: existing?.startedAt ?? this.now(),
        totalTokens: existing?.totalTokens
      })
    }
    for (const [id, task] of prior) {
      if (task.backgrounded && !this.tasks.has(id)) {
        this.retention.rememberRemoved(id, task)
      }
    }
  }

  private upsert(id: string, task: TrackedClaudeBackgroundTask): void {
    if (!this.tasks.has(id) && this.tasks.size >= MAX_TRACKED_TASKS) {
      let foregroundId: string | undefined
      for (const [candidateId, candidate] of this.tasks) {
        if (!candidate.backgrounded) {
          foregroundId = candidateId
          break
        }
      }
      if (!foregroundId) {
        return
      }
      this.tasks.delete(foregroundId)
    }
    const existing = this.tasks.get(id) ?? this.retention.resume(id)
    this.terminalTaskIds.delete(id)
    if (existing) {
      this.tasks.set(id, {
        backgrounded: existing.backgrounded || task.backgrounded,
        kind: task.kind !== 'unknown' ? task.kind : existing.kind,
        description: task.description ?? existing.description,
        name: task.name ?? existing.name,
        state: task.state ?? existing.state,
        startedAt: existing.startedAt,
        totalTokens: existing.totalTokens
      })
      return
    }
    this.tasks.set(id, task)
  }

  private finish(id: string): void {
    this.tasks.delete(id)
    this.terminalTaskIds.delete(id)
    this.terminalTaskIds.add(id)
    if (this.terminalTaskIds.size > MAX_TRACKED_TASKS) {
      const oldest = this.terminalTaskIds.values().next()
      if (!oldest.done) {
        this.terminalTaskIds.delete(oldest.value)
      }
    }
  }

  private refreshMonitoring(): boolean {
    const details = this.backgroundTaskDetails()
    if (details.length === 0 && this.retention.hasSettled) {
      this.retention.flushSettled()
    }
    const next = details.length > 0
    const fingerprint = next ? JSON.stringify([details, this.retention.settledDetails()]) : ''
    if (next === this.monitoring && fingerprint === this.publishedTasksFingerprint) {
      return false
    }
    this.monitoring = next
    this.publishedTasksFingerprint = fingerprint
    return true
  }

  private backgroundTaskDetails(): AgentSessionBackgroundTask[] {
    const details: AgentSessionBackgroundTask[] = []
    for (const [id, task] of this.tasks) {
      if (!task.backgrounded) {
        continue
      }
      details.push(claudeBackgroundTaskDetail(id, task))
    }
    return details
  }
}
