// Roster changes, turn endings and spawn results cannot settle a child.

import type {
  AgentChildWorkKind,
  AgentChildWorkOperation,
  AgentChildWorkOutcome
} from '../../shared/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../shared/agent-status-child-work-evidence'
import {
  classifyClaudeBackgroundTaskKind,
  liveClaudeTaskRunState,
  record,
  taskAliasId,
  taskDescription,
  taskId,
  taskName,
  taskText,
  taskUsageTotalTokens,
  terminalClaudeTaskRunState
} from './claude-background-task-frames'
import { isClaudeSubagentTask } from './claude-subagent-task-frames'
import {
  claudeChildWorkOutcome,
  claudeTaskProgressFacts,
  type ClaudeTaskFacts
} from './claude-child-work-evidence'

type DecodedClaudeTask = {
  kind: AgentChildWorkKind
  backgrounded: boolean
  /** Monitors stay monitoring until the provider reports them running. */
  running: boolean
  name?: string
  description?: string
  toolUseId?: string
}

type PendingEdge = (observedAt: number) => AgentChildWorkEvidence

function observation(
  id: string,
  task: DecodedClaudeTask,
  facts: ClaudeTaskFacts,
  observedAt: number,
  waiting: boolean
): AgentChildWorkLiveObservation {
  const operation: AgentChildWorkOperation | undefined = facts.toolName
    ? { toolName: facts.toolName, basis: 'reported', observedAt }
    : undefined
  return {
    handle: {
      idKind: 'task_id',
      id,
      ...(task.toolUseId !== undefined ? { runId: task.toolUseId } : {})
    },
    kind: task.kind,
    residency: task.backgrounded ? 'background' : 'foreground',
    state: waiting ? 'waiting' : task.running || task.kind !== 'monitor' ? 'working' : 'monitoring',
    ...(task.name ? { name: task.name, agentType: task.name } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(facts.totalTokens !== undefined ? { totalTokens: facts.totalTokens } : {}),
    ...(operation ? { operation } : {}),
    ...(facts.lastMessage ? { lastMessage: facts.lastMessage } : {}),
    // Only background tasks expose a stop target.
    stoppable: task.backgrounded
  }
}

export class ClaudeChildWorkDecoder {
  private readonly live = new Map<string, DecodedClaudeTask>()
  /** Retain ended runs for the session to distinguish wakes from late starts. */
  private readonly ended = new Map<
    string,
    { run: string | undefined; outcome: AgentChildWorkOutcome }
  >()
  private waiting: ReadonlySet<string> = new Set()
  private pending: PendingEdge[] = []

  observe(message: Record<string, unknown>): void {
    if (message.type !== 'system') {
      return
    }
    const id = taskId(message)
    if (!id) {
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
        this.updated(id, record(message.patch))
        return
      case 'task_notification':
        this.end(id, message.status, {
          runId: taskAliasId(message.tool_use_id),
          lastMessage: taskText(message.summary),
          totalTokens: taskUsageTotalTokens(message)
        })
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
    this.live.clear()
    this.ended.clear()
    this.waiting = new Set()
    this.pending.push((observedAt) => ({ type: 'session-ended', observedAt }))
  }

  drain(observedAt: number): AgentChildWorkEvidence[] {
    const pending = this.pending
    this.pending = []
    return pending.map((edge) => edge(observedAt))
  }

  private started(id: string, message: Record<string, unknown>): void {
    if (message.ambient === true || message.skip_transcript === true) {
      return
    }
    const toolUseId = taskAliasId(message.tool_use_id)
    const existing = this.live.get(id)
    const ended = existing ? undefined : this.ended.get(id)
    const restart = ended !== undefined
    // Only successful runs can wake under the same spawn call; other starts are late frames.
    if (ended?.run !== undefined && ended.run === toolUseId && ended.outcome !== 'succeeded') {
      return
    }
    const kind = startedTaskKind(message)
    this.upsert(
      id,
      {
        kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
        backgrounded:
          message.is_backgrounded === true ||
          kind === 'workflow' ||
          kind === 'monitor' ||
          existing?.backgrounded === true,
        running: liveClaudeTaskRunState(message.status) !== null || existing?.running === true,
        name: taskName(message) ?? existing?.name,
        description: taskDescription(message.description) ?? existing?.description,
        toolUseId: toolUseId ?? existing?.toolUseId
      },
      {},
      restart
    )
  }

  private progressed(id: string, message: Record<string, unknown>): void {
    const task = this.live.get(id)
    if (!task) {
      return
    }
    // Progress descriptions describe the current activity, not the task.
    this.upsert(
      id,
      { ...task, name: task.name ?? taskName(message) },
      claudeTaskProgressFacts(message)
    )
  }

  private updated(id: string, patch: Record<string, unknown> | null): void {
    if (!patch) {
      return
    }
    if (terminalClaudeTaskRunState(patch.status) !== null) {
      this.end(id, patch.status, { lastMessage: taskText(patch.error) })
      return
    }
    const existing = this.live.get(id)
    // Late updates cannot reopen an ended task.
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
        toolUseId: existing?.toolUseId
      },
      {},
      false
    )
  }

  private upsert(
    id: string,
    task: DecodedClaudeTask,
    facts: ClaudeTaskFacts,
    restart = false
  ): void {
    this.ended.delete(id)
    this.live.set(id, task)
    this.report(id, task, facts, restart)
  }

  /** Read waiting state at drain so all queued live edges agree. */
  private report(id: string, task: DecodedClaudeTask, facts: ClaudeTaskFacts, restart = false) {
    this.pending.push((observedAt) => ({
      type: 'live',
      observedAt,
      child: observation(id, task, facts, observedAt, this.waiting.has(id)),
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
    }
  ): void {
    const task = this.live.get(id)
    this.live.delete(id)
    const outcome = claudeChildWorkOutcome(status)
    this.ended.set(id, { run: reported.runId ?? task?.toolUseId, outcome })
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

/** Releases predating `task_type` still name an agent in `subagent_type`. */
function startedTaskKind(message: Record<string, unknown>): AgentChildWorkKind {
  return isClaudeSubagentTask(message)
    ? 'agent'
    : classifyClaudeBackgroundTaskKind(message.task_type)
}
