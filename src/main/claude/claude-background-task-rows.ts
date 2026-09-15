// One durable row per Claude background `task_id`, revised in place from the
// lifecycle frames so a failed command prints once with the provider sentence.

import { isSettledBackgroundTaskState } from '../../shared/native-chat-background-task-row'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  classifyClaudeBackgroundTaskKind,
  record,
  taskDescription,
  taskId as readTaskId,
  taskName
} from './claude-background-task-frames'
import {
  claudeBackgroundTaskNotificationChange,
  claudeBackgroundTaskPatchChange,
  claudeBackgroundTaskToolUseId,
  canonicalClaudeBackgroundTaskId,
  isClaudeBackgroundTranscriptTask,
  newClaudeBackgroundTaskRow,
  reviseClaudeBackgroundTaskRow,
  shouldRestartClaudeBackgroundTaskRow,
  type ClaudeBackgroundTaskChange,
  type ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'
import {
  ClaudeBackgroundTaskLedgers,
  ensureClaudeBackgroundTaskRowSlot,
  type ClaudeBackgroundTaskLedgerSizes
} from './claude-background-task-memory'
import { writeClaudeBackgroundTaskRow } from './claude-background-task-row-journal'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import { isClaudeSubagentTask } from './claude-subagent-task-frames'

const MAX_TASK_ROWS = 64

const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification'
])

export type ClaudeBackgroundTaskRowsDeps = {
  sink: StructuredAgentSessionEventSink
  /** Whether a tool id names a tool call this session forwarded at the TOP
   *  level. Consulted on first admission only: a task whose spawning tool never
   *  reached the transcript is a nested child, and a top-level row minted for it
   *  would claim an invocation the user never saw. */
  isForwardedParentTool: (toolUseId: string) => boolean
  /** Opens a turn for the frame being journaled. A typed row is provider
   *  output, so writing one must reopen a turn the provider resumed itself —
   *  otherwise the session renders the row while reporting idle. */
  openOutputTurn?: (frame: Record<string, unknown>, observedAt: number) => void
  now?: () => number
}

export class ClaudeBackgroundTaskRows {
  private readonly rows = new Map<string, ClaudeBackgroundTaskRow>()
  private readonly ledgers = new ClaudeBackgroundTaskLedgers()
  private readonly ids = new ClaudeSubagentIds()
  private readonly now: () => number

  constructor(private readonly deps: ClaudeBackgroundTaskRowsDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** @internal - exposed for tests only: what the bounded ledgers are holding,
   *  so eviction can be proved without reaching into the collections. */
  get ledgerSizes(): ClaudeBackgroundTaskLedgerSizes {
    return this.ledgers.sizes
  }

  /** The frame being journaled right now, so a write can open its turn. Null
   *  outside `observe`: a teardown sweep must never open one. */
  private journaling: { frame: Record<string, unknown>; observedAt: number } | null = null

  observe(message: Record<string, unknown>, observedAt: number = this.now()): boolean {
    this.journaling = { frame: message, observedAt }
    try {
      return this.observeFrame(message)
    } finally {
      this.journaling = null
    }
  }

  private observeFrame(message: Record<string, unknown>): boolean {
    if (message.type !== 'system') {
      return false
    }
    if (message.subtype === 'background_tasks_changed') {
      if (!Array.isArray(message.tasks)) {
        return false
      }
      this.observeAggregateRoster(message.tasks)
      return true
    }
    if (typeof message.subtype !== 'string' || !TASK_SUBTYPES.has(message.subtype)) {
      return false
    }
    const id = canonicalClaudeBackgroundTaskId(message, this.ids)
    if (id === null) {
      return false
    }
    if (message.subtype === 'task_started') {
      return this.observeStart(id, message)
    }
    if (this.ledgers.foreign.has(id)) {
      return true
    }
    if (message.subtype === 'task_notification') {
      return this.observeNotification(id, message)
    }
    return this.observePatch(id, message)
  }

  settleSession(): void {
    for (const [id, row] of this.rows) {
      if (!isSettledBackgroundTaskState(row.block.state)) {
        this.revise(id, { state: 'unverifiable' })
      }
    }
  }

  dispose(): void {
    this.settleSession()
    this.rows.clear()
    this.ledgers.clear()
    this.ids.clear()
  }

  private observeStart(id: string, message: Record<string, unknown>): boolean {
    if (this.ledgers.fallbackTaskIds.has(id)) {
      if (this.ledgers.terminalTaskIds.has(id)) {
        const previousToolUseId = this.ledgers.terminalToolUseIds.get(id)
        const currentToolUseId = claudeBackgroundTaskToolUseId(message)
        if (
          previousToolUseId !== undefined &&
          currentToolUseId !== undefined &&
          previousToolUseId !== currentToolUseId
        ) {
          this.ledgers.fallbackTaskIds.delete(id)
        } else {
          return false
        }
      } else {
        return false
      }
    }
    if (message.ambient === true || message.skip_transcript === true) {
      this.ledgers.rememberForeign(id, 'ambient')
      return true
    }
    if (isClaudeSubagentTask(message)) {
      this.ledgers.rememberForeign(id, 'roster')
      return true
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    if (!isClaudeBackgroundTranscriptTask(message, kind)) {
      this.ledgers.rememberForeign(id, 'foreground')
      return true
    }
    this.ledgers.foreign.delete(id)
    const existing = this.rows.get(id)
    if (existing) {
      // A task that already exists and has not finished is not re-opened: a
      // duplicate announcement is a redelivery, not a second run, and treating
      // it as one would restate a row the user is already reading.
      if (!isSettledBackgroundTaskState(existing.block.state)) {
        return true
      }
      if (shouldRestartClaudeBackgroundTaskRow(existing, message)) {
        this.openRow(id, message)
      }
      return true
    }
    let restartedTerminal = false
    if (this.ledgers.terminalTaskIds.has(id)) {
      const previousToolUseId = this.ledgers.terminalToolUseIds.get(id)
      const currentToolUseId = claudeBackgroundTaskToolUseId(message)
      // A terminal edge that had no usable tool id cannot prove a later start
      // is a new run, so keep the conservative orphan guard. When both runs
      // name their parent, a different alias is the provider's restart signal.
      if (
        previousToolUseId === undefined ||
        currentToolUseId === undefined ||
        previousToolUseId === currentToolUseId
      ) {
        return true
      }
      restartedTerminal = true
    }
    if (!this.admitsFirstRun(message)) {
      return true
    }
    if (!ensureClaudeBackgroundTaskRowSlot(this.rows, MAX_TASK_ROWS)) {
      this.ledgers.rememberFallback(id)
      return false
    }
    if (restartedTerminal) {
      this.ledgers.terminalTaskIds.delete(id)
      this.ledgers.terminalToolUseIds.delete(id)
    }
    this.openRow(id, message)
    return true
  }

  /** The gate a task passes ONCE, when its first row is minted. Later frames
   *  for an admitted task are never re-gated: the decision belongs to the
   *  announcement, and re-asking it on a patch that carries no `tool_use_id`
   *  would drop the outcome of a task already on screen. */
  private admitsFirstRun(message: Record<string, unknown>): boolean {
    const toolUseId = claudeBackgroundTaskToolUseId(message)
    // Conditional on the field being PRESENT. An announcement that names a tool
    // this session never forwarded is a nested child and is refused; one that
    // names no tool at all is admitted, because there is nothing to contradict
    // — absence of the field is not evidence of an unforwarded parent.
    return toolUseId === undefined || this.deps.isForwardedParentTool(toolUseId)
  }

  private openRow(id: string, message: Record<string, unknown>): void {
    const generation = this.ledgers.generations.next(id)
    this.rows.set(id, newClaudeBackgroundTaskRow(id, message, this.now(), generation))
    this.write(id)
  }

  private observeNotification(id: string, message: Record<string, unknown>): boolean {
    if (this.ledgers.fallbackTaskIds.has(id)) {
      this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
      this.ledgers.fallbackTaskIds.delete(id)
      return false
    }
    const row = this.rows.get(id)
    if (row && row.terminalNotificationReceived) {
      return true
    }
    // Remembered even for a task never admitted: Orca is deliberately stricter
    // than the reference here, which keeps no trace of one. It stops a late
    // announcement from opening a row for work already reported finished.
    this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
    if (!row) {
      // Matched on `task_id` alone. A terminal frame for a task that was never
      // admitted names nothing this transcript is tracking, so it yields no
      // row — the forwarded-parent question was already settled at admission
      // and is never re-asked here.
      return true
    }
    this.revise(id, claudeBackgroundTaskNotificationChange(message))
    row.terminalNotificationReceived = true
    return true
  }

  private observePatch(id: string, message: Record<string, unknown>): boolean {
    if (this.ledgers.fallbackTaskIds.has(id)) {
      const change = claudeBackgroundTaskPatchChange(message)
      if (change.state && isSettledBackgroundTaskState(change.state)) {
        this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
      }
      return false
    }
    const row = this.rows.get(id)
    if (row && isSettledBackgroundTaskState(row.block.state)) {
      return true
    }
    const patch = record(message.patch)
    // A tracked row remains this owner's responsibility even if a later patch
    // reports foreground execution; its terminal notification still revises
    // the durable row. Only an untracked task belongs to the foreground owner.
    if (patch?.is_backgrounded === false && !this.rows.has(id)) {
      this.ledgers.rememberForeign(id, 'foreground')
      return true
    }
    const change = claudeBackgroundTaskPatchChange(message)
    if (change.state && isSettledBackgroundTaskState(change.state)) {
      this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
    }
    // A patch is folded into the row it names and is never a row of its own, so
    // an untracked task takes no row from it.
    if (row) {
      this.revise(id, change)
    }
    return true
  }

  private observeAggregateRoster(value: unknown): void {
    if (!Array.isArray(value)) {
      return
    }
    for (const entry of value) {
      const task = record(entry)
      const id = task === null ? null : readTaskId(task)
      const row = id === null ? undefined : this.rows.get(id)
      if (
        task === null ||
        id === null ||
        task.ambient === true ||
        !row ||
        isSettledBackgroundTaskState(row.block.state)
      ) {
        continue
      }
      // Membership is the ONLY liveness this payload carries: it is the whole
      // live set after a change, so presence means live and absence means
      // merely "no longer listed", never an outcome. Its per-entry status is
      // NOT read, because the payload has no such field — reading one derived a
      // state that was always undefined and left the reopen branch it guarded
      // unreachable on every real payload.
      //
      // Presence does not revive a settled row either. The payload is a level
      // signal whose ordering against the start/stop edges is unspecified, and
      // it carries no evidence of a NEW run — so a row that reported its own
      // outcome keeps it, and the task's own frames remain the only thing that
      // opens or settles one. Only the identity fields it really sends are read.
      this.revise(id, {
        label: taskDescription(task.description) ?? taskName(task),
        kind:
          task.task_type === undefined
            ? undefined
            : classifyClaudeBackgroundTaskKind(task.task_type)
      })
    }
  }

  private revise(id: string, change: ClaudeBackgroundTaskChange): void {
    const row = this.rows.get(id)
    if (!row) {
      return
    }
    const wasLive = !isSettledBackgroundTaskState(row.block.state)
    reviseClaudeBackgroundTaskRow(row, change, this.now())
    this.write(id, wasLive)
  }

  private write(id: string, openOutputTurn = true): void {
    const row = this.rows.get(id)
    if (!row) {
      return
    }
    const journaling = this.journaling
    writeClaudeBackgroundTaskRow(this.deps.sink, id, row, () => {
      if (journaling && openOutputTurn) {
        this.deps.openOutputTurn?.(journaling.frame, journaling.observedAt)
      }
    })
  }
}
