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
  claudeBackgroundTaskDetails,
  hasLiveClaudeBackgroundWork,
  type TrackedClaudeBackgroundTask
} from './claude-settled-background-tasks'
import { combineClaudeBackgroundTaskRoster } from './claude-background-task-roster-merge'

export {
  classifyClaudeBackgroundTaskKind,
  isBoundedClaudeTaskId,
  taskDescription as claudeTaskDescription,
  taskId as claudeTaskId
} from './claude-background-task-frames'
export type { ClaudeBackgroundTaskKind } from './claude-background-task-frames'

// Bound terminal IDs without evicting live tasks.
const MAX_TERMINAL_TASK_IDS = 256
export type ClaudeGoalBackgroundWork = 'live' | 'unverifiable' | 'exited'

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedClaudeBackgroundTask>()
  private readonly retention = new ClaudeSettledBackgroundTasks()
  private readonly terminalTaskIds = new Set<string>()
  private aggregateRosterObserved = false
  private coverageIncomplete = false
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

  get goalBackgroundWork(): ClaudeGoalBackgroundWork {
    return hasLiveClaudeBackgroundWork(this.tasks.values())
      ? 'live'
      : this.coverageIncomplete
        ? 'unverifiable'
        : 'exited'
  }

  observe(message: Record<string, unknown>, startsTurn = false): boolean {
    // Turn changes retire foreground work; background visibility depends on provider evidence.
    if (startsTurn || message.type === 'result') {
      this.settleForegroundTasks()
    }
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
    this.coverageIncomplete = false
    return this.refreshMonitoring()
  }

  private settleForegroundTasks(): void {
    for (const task of this.tasks.values()) {
      if (!task.backgrounded) {
        task.liveInTurn = false
      }
    }
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
      // A terminal notification settles liveness even if its status is unreadable.
      this.settle(id, terminalClaudeTaskRunState(message.status) ?? 'done', {
        totalTokens: taskUsageTotalTokens(message)
      })
      return true
    }
    if (message.subtype === 'task_progress') {
      // Progress descriptions are transient activity; preserve the task name.
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
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    const backgrounded =
      message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor'
    // The aggregate roster is authoritative only for background work.
    if (this.aggregateRosterObserved && backgrounded && !this.tasks.has(id)) {
      return false
    }
    this.upsert(id, {
      backgrounded,
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
      this.coverageIncomplete = true
      return
    }
    const prior = new Map(this.tasks)
    this.aggregateRosterObserved = true
    this.tasks.clear()
    const roster = new Map<string, TrackedClaudeBackgroundTask>()
    let coverageIncomplete = false
    for (const valueTask of value) {
      const task = record(valueTask)
      if (!task) {
        coverageIncomplete = true
        continue
      }
      if (task.ambient === true) {
        continue
      }
      const id = taskId(task)
      if (!id) {
        coverageIncomplete = true
        continue
      }
      // Only explicitly rostered IDs supersede terminal evidence; preserve finished foreground IDs.
      this.terminalTaskIds.delete(id)
      const existing = prior.get(id) ?? this.retention.resume(id)
      const kind = classifyClaudeBackgroundTaskKind(task.task_type)
      roster.set(id, {
        backgrounded: true,
        liveInTurn: true,
        kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
        description: taskDescription(task.description) ?? existing?.description,
        name: taskName(task) ?? existing?.name,
        state: liveClaudeTaskRunState(task.status) ?? existing?.state,
        startedAt: existing?.startedAt ?? this.now(),
        totalTokens: existing?.totalTokens
      })
    }
    this.coverageIncomplete = coverageIncomplete
    for (const [id, task] of combineClaudeBackgroundTaskRoster(prior, roster)) {
      this.tasks.set(id, task)
    }
    for (const [id, task] of prior) {
      if (task.backgrounded && !this.tasks.has(id)) {
        this.retention.rememberRemoved(id, task)
      }
    }
  }

  private upsert(id: string, task: Omit<TrackedClaudeBackgroundTask, 'liveInTurn'>): void {
    const existing = this.tasks.get(id) ?? this.retention.resume(id)
    this.terminalTaskIds.delete(id)
    if (existing) {
      this.tasks.set(id, {
        backgrounded: existing.backgrounded || task.backgrounded,
        // A settled foreground task is not revived by a late edge frame.
        liveInTurn: existing.liveInTurn,
        kind: task.kind !== 'unknown' ? task.kind : existing.kind,
        description: task.description ?? existing.description,
        name: task.name ?? existing.name,
        state: task.state ?? existing.state,
        startedAt: existing.startedAt,
        totalTokens: existing.totalTokens
      })
      return
    }
    this.tasks.set(id, { ...task, liveInTurn: true })
  }

  private finish(id: string): void {
    this.tasks.delete(id)
    this.terminalTaskIds.delete(id)
    this.terminalTaskIds.add(id)
    if (this.terminalTaskIds.size > MAX_TERMINAL_TASK_IDS) {
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
    return claudeBackgroundTaskDetails(this.tasks)
  }
}
