// Roster changes, turn endings and spawn results cannot settle a child.

import { ClaudeTaskInvocations } from '../background-tasks/claude-task-invocations'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { classifyClaudeBackgroundTaskKind } from '../../../shared/claude-background-task-kind'
import {
  liveClaudeTaskRunState,
  record,
  taskAliasId,
  taskDescription,
  taskId,
  taskName,
  taskText,
  taskUsageTotalTokens,
  terminalClaudeTaskRunState
} from '../background-tasks/claude-background-task-frames'
import { claudeStartedTaskKind } from '../subagents/claude-subagent-task-frames'
import { ClaudeAgentWaitCalls } from './claude-agent-wait-calls'
import {
  claudeChildWorkOutcome,
  claudeChildWorkObservation,
  type DecodedClaudeTask,
  type EndedClaudeTask,
  claudeTaskProgressFacts,
  type ClaudeTaskFacts
} from './claude-child-work-evidence'

type ClaudeToolOwner = (toolUseId: string) => string | null

type PendingEdge = (observedAt: number) => AgentChildWorkEvidence

export class ClaudeChildWorkDecoder {
  private readonly live = new Map<string, DecodedClaudeTask>()
  /** Retain ended runs for the session to distinguish wakes from late starts. */
  private readonly ended = new Map<string, EndedClaudeTask>()
  private readonly childrenByOwner = new Map<string, Set<string>>()
  private waiting: ReadonlySet<string> = new Set()
  private pending: PendingEdge[] = []
  private readonly agentWaits = new ClaudeAgentWaitCalls()
  /** `ownerOf` names the subagent that made a child tool call; an ending task wakes it. */
  constructor(readonly taskInvocations = new ClaudeTaskInvocations()) {}

  observe(message: Record<string, unknown>, ownerOf?: ClaudeToolOwner): void {
    this.taskInvocations.observe(message)
    if (message.type === 'assistant') {
      this.agentWaits.observe(message)
      return
    }
    if (message.type !== 'system') {
      return
    }
    if (message.subtype === 'background_tasks_changed') {
      if (Array.isArray(message.tasks)) {
        for (const entry of message.tasks) {
          const task = record(entry)
          const id = task && taskId(task)
          if (
            task &&
            id &&
            !this.ended.has(id) &&
            this.taskInvocations.parentOf(id, taskAliasId(task.tool_use_id))
          ) {
            this.started(id, task, true)
          }
        }
      }
      return
    }
    const id = taskId(message)
    if (!id) {
      return
    }
    const selected = this.taskInvocations.selection(message, id)
    if (selected && (!selected.current || selected.invocation.excluded)) {
      return
    }
    switch (message.subtype) {
      case 'task_started':
        this.started(id, message)
        return
      case 'task_progress':
        this.progressed(id, message)
        return
      case 'task_updated':
        this.updated(id, record(message.patch), ownerOf)
        return
      case 'task_notification':
        this.end(
          id,
          message.status,
          {
            runId: taskAliasId(message.tool_use_id),
            lastMessage: taskText(message.summary),
            totalTokens: taskUsageTotalTokens(message)
          },
          ownerOf
        )
    }
  }

  observeWaiting(waiting: ReadonlySet<string>): void {
    const previous = this.waiting
    this.waiting = waiting
    for (const id of new Set([...previous, ...waiting])) {
      const task = this.live.get(id)
      if (task && previous.has(id) !== waiting.has(id)) {
        this.report(id, task, {})
      }
    }
  }

  clear(): void {
    this.taskInvocations.clear()
    this.live.clear()
    this.ended.clear()
    this.childrenByOwner.clear()
    this.agentWaits.clear()
    this.waiting = new Set()
    this.pending.push((observedAt) => ({ type: 'session-ended', observedAt }))
  }

  drain(observedAt: number): AgentChildWorkEvidence[] {
    const pending = this.pending
    this.pending = []
    return pending.map((edge) => edge(observedAt))
  }

  private started(id: string, message: Record<string, unknown>, roster = false): void {
    const selection = this.taskInvocations.selection(message, id)
    if (!selection?.acceptsStart || selection.invocation.excluded) {
      return
    }
    const invocation = selection.invocation
    const toolUseId = invocation.toolUseId
    const awaitsAgents = this.agentWaits.take(toolUseId)
    const existing = this.live.get(id)
    const ended = existing ? undefined : this.ended.get(id)
    const restart = ended !== undefined
    // Only successful runs can wake under the same spawn call; other starts are late frames.
    if (ended?.run !== undefined && ended.run === toolUseId && ended.outcome !== 'succeeded') {
      return
    }
    const kind = claudeStartedTaskKind(message)
    this.upsert(
      id,
      {
        kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
        backgrounded:
          roster ||
          message.is_backgrounded === true ||
          kind === 'workflow' ||
          kind === 'monitor' ||
          existing?.backgrounded === true,
        running: liveClaudeTaskRunState(message.status) !== null || existing?.running === true,
        name: taskName(message) ?? existing?.name,
        description: taskDescription(message.description) ?? existing?.description,
        toolUseId: toolUseId ?? existing?.toolUseId,
        parentTaskId: invocation.parentTaskId,
        ...(awaitsAgents || existing?.awaitsAgents ? { awaitsAgents: true as const } : {})
      },
      {},
      restart,
      roster
    )
  }

  /** Claude resumes a finished subagent when a task it launched notifies; show it working from that frame, not its restart a moment later. */
  private wakeOwner(
    toolUseId: string | undefined,
    ownerOf: ClaudeToolOwner | undefined,
    parentTaskId?: string
  ): void {
    const ownerId = parentTaskId ?? (toolUseId ? ownerOf?.(toolUseId) : null)
    const owner = ownerId ? this.ended.get(ownerId) : undefined
    if (ownerId && owner?.outcome === 'succeeded' && owner.task?.kind === 'agent') {
      this.upsert(ownerId, { ...owner.task, running: true }, {}, true)
    }
  }

  private progressed(id: string, message: Record<string, unknown>): void {
    const task = this.live.get(id)
    if (!task) {
      return
    }
    // Progress descriptions describe the current activity, not the task.
    const name = task.name ?? taskName(message)
    this.upsert(id, { ...task, name }, claudeTaskProgressFacts(message))
  }

  private updated(
    id: string,
    patch: Record<string, unknown> | null,
    ownerOf: ClaudeToolOwner | undefined
  ): void {
    if (!patch) {
      return
    }
    const existing = this.live.get(id)
    if (terminalClaudeTaskRunState(patch.status) !== null) {
      // A background agent's ending always notifies its launcher at once; ending here would show the launcher finished before that wake.
      if (existing?.backgrounded !== true || existing.kind !== 'agent') {
        this.end(id, patch.status, { lastMessage: taskText(patch.error) }, ownerOf)
      }
      return
    }
    if (!existing && this.ended.has(id)) {
      return
    }
    const kind =
      'task_type' in patch ? classifyClaudeBackgroundTaskKind(patch.task_type) : 'unknown'
    const running = liveClaudeTaskRunState(patch.status) !== null
    const name = taskName(patch)
    const description = taskDescription(patch.description)
    if (patch.is_backgrounded !== true && !name && !description && !running && kind === 'unknown') {
      return
    }
    this.upsert(
      id,
      {
        kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
        backgrounded: patch.is_backgrounded === true || existing?.backgrounded === true,
        running: running || existing?.running === true,
        name: name ?? existing?.name,
        description: description ?? existing?.description,
        toolUseId: existing?.toolUseId,
        parentTaskId: existing?.parentTaskId,
        ...(existing?.awaitsAgents ? { awaitsAgents: true as const } : {})
      },
      {},
      false
    )
  }

  private upsert(
    id: string,
    task: DecodedClaudeTask,
    facts: ClaudeTaskFacts,
    restart = false,
    unchangedRoster = false
  ): void {
    if (unchangedRoster && JSON.stringify(task) === JSON.stringify(this.live.get(id))) {
      return
    }
    const ownerBecameLive = !this.live.has(id) || restart
    this.ended.delete(id)
    this.removeOwnerIndex(id)
    this.live.set(id, task)
    if (task.parentTaskId) {
      const children = this.childrenByOwner.get(task.parentTaskId) ?? new Set<string>()
      children.add(id)
      this.childrenByOwner.set(task.parentTaskId, children)
    }
    this.report(id, task, facts, restart)
    // Admission can resolve a child's raw owner only after that owner's live edge.
    if (!ownerBecameLive) {
      return
    }
    for (const childId of this.childrenByOwner.get(id) ?? []) {
      const child = this.live.get(childId)
      if (child && childId !== id) {
        this.report(childId, child, {})
      }
    }
  }

  private removeOwnerIndex(id: string): void {
    const parent = this.live.get(id)?.parentTaskId
    if (parent === undefined) {
      return
    }
    const children = this.childrenByOwner.get(parent)
    children?.delete(id)
    if (children?.size === 0) {
      this.childrenByOwner.delete(parent)
    }
  }

  /** Read waiting state at drain so all queued live edges agree. */
  private report(id: string, task: DecodedClaudeTask, facts: ClaudeTaskFacts, restart = false) {
    this.pending.push((observedAt) => ({
      type: 'live',
      observedAt,
      child: claudeChildWorkObservation(id, task, facts, observedAt, this.waiting.has(id)),
      ...(restart ? { restart: true } : {})
    }))
  }

  private end(
    id: string,
    status: unknown,
    reported: {
      runId?: string
      lastMessage?: string
      totalTokens?: number
    },
    ownerOf?: ClaudeToolOwner
  ): void {
    const task = this.live.get(id)
    this.taskInvocations.settle(id, status, reported.runId ?? task?.toolUseId)
    this.removeOwnerIndex(id)
    this.live.delete(id)
    const outcome = claudeChildWorkOutcome(status)
    this.ended.set(id, {
      run: reported.runId ?? task?.toolUseId,
      outcome,
      // Kept only for an agent a task it launched can wake.
      ...(task?.kind === 'agent' ? { task } : {})
    })
    // Every ending but a stop notifies, which wakes the subagent that launched the task.
    if (outcome !== 'cancelled') {
      this.wakeOwner(reported.runId ?? task?.toolUseId, ownerOf, task?.parentTaskId)
    }
    this.pending.push((observedAt) => ({
      type: 'ended',
      observedAt,
      handle: {
        idKind: 'task_id',
        id,
        ...(reported.runId !== undefined ? { runId: reported.runId } : {})
      },
      outcome,
      ...(reported.lastMessage ? { lastMessage: reported.lastMessage } : {}),
      ...(reported.totalTokens !== undefined ? { totalTokens: reported.totalTokens } : {})
    }))
  }
}
