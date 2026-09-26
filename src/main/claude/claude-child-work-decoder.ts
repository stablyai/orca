// Claude task frames, read as each child's own account of itself.
//
// A child is live from its `task_started` until its own terminal `task_updated` or
// `task_notification`; nothing else ends it. A roster (`background_tasks_changed`), a turn ending
// or a spawn call returning is the parent's view of the child, not the child's, and the CLI sends
// every child its own terminal frame, so none of them settles one. When the session ends, the
// host settles whatever is still live. Edges wait here until the frame is journaled, then take
// the host clock.

import type {
  AgentChildWorkKind,
  AgentChildWorkOperation
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
import {
  claudeChildWorkOutcome,
  claudeTaskProgressFacts,
  type ClaudeTaskFacts
} from './claude-child-work-evidence'

/** Live children one session tracks, and the ended ids it remembers to recognise a restart. */
const MAX_LIVE_TASKS = 256
const MAX_ENDED_TASKS = 256

type DecodedClaudeTask = {
  kind: AgentChildWorkKind
  backgrounded: boolean
  /** The provider has reported it running; a monitor that never has reads as monitoring. */
  running: boolean
  name?: string
  description?: string
  /** The spawn call of the current run. */
  toolUseId?: string
}

type PendingEdge = (observedAt: number) => AgentChildWorkEvidence

function observation(
  id: string,
  task: DecodedClaudeTask,
  facts: ClaudeTaskFacts,
  observedAt: number
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
    state: task.running || task.kind !== 'monitor' ? 'working' : 'monitoring',
    // The published row names a task's type as both its name and its agent type.
    ...(task.name ? { name: task.name, agentType: task.name } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(facts.totalTokens !== undefined ? { totalTokens: facts.totalTokens } : {}),
    ...(operation ? { operation } : {}),
    ...(facts.lastMessage ? { lastMessage: facts.lastMessage } : {}),
    // Only a backgrounded task has a stop the host can target.
    stoppable: task.backgrounded
  }
}

export class ClaudeChildWorkDecoder {
  private readonly live = new Map<string, DecodedClaudeTask>()
  /** Ended task ids, with the spawn call each ended under. */
  private readonly ended = new Map<string, string | undefined>()
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
        // Its `tool_use_id` names the run that ended (captured on a resumed agent's second run).
        this.end(id, message.status, {
          runId: taskAliasId(message.tool_use_id),
          lastMessage: taskText(message.summary),
          totalTokens: taskUsageTotalTokens(message)
        })
    }
  }

  /** The provider session is gone: the host settles what it still holds live. */
  clear(): void {
    this.live.clear()
    this.ended.clear()
    this.pending.push((observedAt) => ({ type: 'session-ended', observedAt }))
  }

  drain(observedAt: number): AgentChildWorkEvidence[] {
    const pending = this.pending
    this.pending = []
    return pending.map((edge) => edge(observedAt))
  }

  private started(id: string, message: Record<string, unknown>): void {
    // Work the CLI hides from its own transcript is not a child the user sees.
    if (message.ambient === true || message.skip_transcript === true) {
      return
    }
    const toolUseId = taskAliasId(message.tool_use_id)
    const existing = this.live.get(id)
    const restart = !existing && this.ended.has(id)
    // A start under the spawn call a run ended with is that run's late start, not a new run.
    if (restart && toolUseId !== undefined && this.ended.get(id) === toolUseId) {
      return
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
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
    // Progress `description` is the current activity ("Running <tool>"), not the task's name.
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
    // Only a start re-opens an ended task; a late update from its run does not.
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
    if (!this.live.has(id) && this.live.size >= MAX_LIVE_TASKS) {
      return
    }
    this.ended.delete(id)
    this.live.set(id, task)
    this.pending.push((observedAt) => ({
      type: 'live',
      observedAt,
      child: observation(id, task, facts, observedAt),
      ...(restart ? { restart: true } : {})
    }))
  }

  private end(
    id: string,
    status: unknown,
    reported: { runId?: string; lastMessage?: string; totalTokens?: number }
  ): void {
    const task = this.live.get(id)
    this.live.delete(id)
    this.ended.delete(id)
    this.ended.set(id, reported.runId ?? task?.toolUseId)
    if (this.ended.size > MAX_ENDED_TASKS) {
      const [oldest] = this.ended.keys()
      if (oldest !== undefined) {
        this.ended.delete(oldest)
      }
    }
    const outcome = claudeChildWorkOutcome(status)
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
