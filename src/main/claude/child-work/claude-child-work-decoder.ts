// Roster changes, turn endings and spawn results cannot settle a child.

import { ClaudeTaskInvocations } from '../background-tasks/claude-task-invocations'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { classifyClaudeBackgroundTaskKind } from '../../../shared/agent-hook-listener/providers/claude/background-tasks/claude-background-task-kind'
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
import { childWorkEndedEvidence, claudeChildWake } from './claude-child-wake-lease'
import { ClaudeChildOwnerIndex } from './claude-child-owner-index'
// tf: the decoder's task-frame rules (roster starts, turn ends, survivors).
import * as tf from './claude-child-work-roster'
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
  /** Read-only outside the decoder; Steer moves the top-level foreground ones to the background. */
  readonly live = new Map<string, DecodedClaudeTask>()
  /** Retain ended runs for the session to distinguish wakes from late starts. */
  private readonly ended = new Map<string, EndedClaudeTask>()
  private readonly childrenByOwner = new ClaudeChildOwnerIndex()
  private waiting: ReadonlySet<string> = new Set()
  private pending: PendingEdge[] = []
  private readonly agentWaits = new ClaudeAgentWaitCalls()
  private readonly wake = claudeChildWake({
    endedOwner: (id) => this.ended.get(id),
    showWorking: (id, task) => this.upsert(id, { ...task, running: true }, {}, true),
    restore: (id, owner) => this.settleWake(id, owner),
    revive: (id, runningFrame) => this.started(id, tf.claudeRosterStart(id, runningFrame), true)
  })
  /** `ownerOf` names the subagent that made a child tool call; an ending task wakes it. */
  constructor(readonly taskInvocations = new ClaudeTaskInvocations()) {}

  observe(message: Record<string, unknown>, ownerOf?: ClaudeToolOwner): void {
    this.taskInvocations.observe(message)
    if (message.type === 'assistant') {
      this.agentWaits.observe(message)
      return
    }
    if (tf.claudeLeadTurnEnded(message, this.live)) {
      this.surfaceForegroundCommands(undefined, ownerOf)
    }
    if (message.type !== 'system') {
      return
    }
    if (message.subtype === 'background_tasks_changed') {
      const known = { live: this.live, ended: this.ended, parentOf: this.taskInvocations.parentOf }
      for (const [id, task] of tf.claudeRosterStarts(message, known)) {
        this.started(id, task, true)
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
    // Only a frame the decoder admits proves the provider runs this owner; a historical alias
    // that is ignored above would otherwise clear the lease and leave the row working for good.
    const runningFrame = tf.claudeRunningFrame(message)
    if (runningFrame) {
      this.wake.confirmRunning(id, runningFrame)
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
            // A forked command's summary only repeats its name.
            lastMessage: selected?.invocation.forkedCommand ? undefined : taskText(message.summary),
            totalTokens: taskUsageTotalTokens(message)
          },
          ownerOf
        )
    }
  }

  /** See claudeForegroundCommandSurvivors. */
  private surfaceForegroundCommands(ownerId: string | undefined, ownerOf?: ClaudeToolOwner): void {
    for (const [id, task] of tf.claudeForegroundCommandSurvivors(this.live, ownerId, ownerOf)) {
      this.upsert(id, task, {})
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
    this.wake.clear()
    this.waiting = new Set()
    this.pending.push((observedAt) => ({ type: 'session-ended', observedAt }))
  }

  /** When, on the monotonic clock, a held wake stops guessing; the host restates the row then. */
  wakeExpiryAt(): number | undefined {
    return this.wake.earliestExpiry()
  }

  drain(observedAt: number): AgentChildWorkEvidence[] {
    // A wake that outlived its lease restores the ending it guessed past, before this drain reads it.
    this.wake.settleExpired()
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
    this.wake.confirmRunning(id, message)
    const kind = claudeStartedTaskKind(message)
    // A roster entry carries only id and status, so a start that revives an ended owner must
    // restore the saved task. Both cases reach it: a spent wake restores the ending before the
    // sweep sees it, so `existing` holds the task by now; a live wake leaves it in `ended`.
    const carried = existing ?? ended?.task
    this.upsert(
      id,
      {
        kind: kind !== 'unknown' ? kind : (carried?.kind ?? 'unknown'),
        backgrounded:
          roster ||
          message.is_backgrounded === true ||
          kind === 'workflow' ||
          kind === 'monitor' ||
          carried?.backgrounded === true,
        running: liveClaudeTaskRunState(message.status) !== null || carried?.running === true,
        name: taskName(message) ?? carried?.name,
        description: taskDescription(message.description) ?? carried?.description,
        toolUseId: toolUseId ?? carried?.toolUseId,
        parentTaskId: invocation.parentTaskId,
        ...tf.claudeCarriedMarks(existing, toolUseId, awaitsAgents)
      },
      {},
      restart,
      roster
    )
  }

  /** Put the owner back to the ending the wake guessed past, unless a real frame replaced it. */
  private settleWake(ownerId: string, restored: EndedClaudeTask): void {
    // Only the running wake itself is ours to undo; a stop or a restart leaves a different record.
    if (this.live.get(ownerId)?.running !== true) {
      return
    }
    this.childrenByOwner.forget(ownerId, this.live.get(ownerId))
    this.live.delete(ownerId)
    this.ended.set(ownerId, restored)
    this.pending.push((observedAt) =>
      childWorkEndedEvidence(ownerId, restored.run, restored.outcome, observedAt, restored.reported)
    )
  }

  private progressed(id: string, message: Record<string, unknown>): void {
    const task = this.live.get(id)
    if (!task) {
      return
    }
    // Progress descriptions describe the current activity, not the task.
    const name = task.name ?? taskName(message)
    this.upsert(id, { ...tf.claudeTaskSeenAgain(task), name }, claudeTaskProgressFacts(message))
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
        ...tf.claudeCarriedMarks(existing, existing?.toolUseId)
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
    this.childrenByOwner.setLive(id, task, this.live.get(id))
    this.live.set(id, task)
    this.report(id, task, facts, restart)
    // Admission can resolve a child's raw owner only after that owner's live edge.
    if (!ownerBecameLive) {
      return
    }
    for (const childId of this.childrenByOwner.children(id)) {
      const child = this.live.get(childId)
      if (child && childId !== id) {
        this.report(childId, child, {})
      }
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
    this.childrenByOwner.forget(id, task)
    this.live.delete(id)
    // A real ending replaces any guess about this task.
    this.wake.drop(id)
    const outcome = claudeChildWorkOutcome(status)
    this.ended.set(id, {
      run: reported.runId ?? task?.toolUseId,
      outcome,
      // Kept only for an agent a task it launched can wake.
      ...(task?.kind === 'agent' ? { task, reported } : {})
    })
    if (outcome !== 'cancelled') {
      // Every ending but a stop notifies, which wakes the subagent that launched the task.
      this.wake.fromEnding(reported.runId ?? task?.toolUseId, ownerOf, task?.parentTaskId)
    }
    this.pending.push((observedAt) =>
      childWorkEndedEvidence(id, reported.runId, outcome, observedAt, reported)
    )
    // Its own foreground commands could not outlive it either.
    this.surfaceForegroundCommands(id, ownerOf)
  }
}
