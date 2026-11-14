import { ClaudeTaskInvocations } from './claude-task-invocations'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { isSettledBackgroundTaskState } from '../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { BoundedMap } from '../../../shared/bounded-map'
import {
  record,
  taskAliasId,
  CLAUDE_BACKGROUND_TASK_ROW_SUBTYPES
} from './claude-background-task-frames'
import {
  attributeClaudeBackgroundTaskRow,
  claudeBackgroundTaskPatchChange,
  claudeBackgroundTaskToolUseId,
  canonicalClaudeBackgroundTaskId,
  finalizeClaudeBackgroundTaskRow,
  newClaudeBackgroundTaskRow,
  newClaudeBackgroundTaskRowFromNotification,
  reviseClaudeBackgroundTaskRow,
  type ClaudeBackgroundTaskChange,
  type ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'
import {
  ClaudeBackgroundTaskLedgers,
  ensureClaudeBackgroundTaskRowSlot,
  type ClaudeBackgroundTaskLedgerSizes
} from './claude-background-task-memory'
import {
  ClaudeBackgroundTaskRowWriter,
  createClaudeBackgroundTaskTurnOpener
} from './claude-background-task-row-writer'
import { observeClaudeBackgroundTaskStart } from './claude-background-task-start'
import { observeOwnedClaudeBackgroundTaskRoster } from './claude-background-task-roster'
import { ClaudeSubagentIds } from '../subagents/claude-subagent-id-aliases'
import { ClaudeOverflowTerminalRows } from './claude-overflow-terminal-rows'

const MAX_TASK_ROWS = 64

export type ClaudeBackgroundTaskRowsDeps = {
  sink: StructuredAgentSessionEventSink
  /** Require a forwarded top-level invocation on first admission to exclude nested children. */
  isForwardedParentTool: (toolUseId: string) => boolean
  /** Recover earlier-run subagent ownership when Claude does not repeat its announcement. */
  taskInvocations?: ClaudeTaskInvocations
  rosteredByEarlierRun?: (taskId: string) => boolean
  /** Reopen provider-resumed turns before journaling output so the session reports working. */
  openOutputTurn?: (frame: Record<string, unknown>, observedAt: number) => void
  /** The turn a row written now belongs to: the open one, else the conversation. */
  turnScope: () => AgentJournalTurnScope
  onPersistenceFailure?: (error: Error) => void
  now?: () => number
}

export class ClaudeBackgroundTaskRows {
  private readonly rows = new Map<string, ClaudeBackgroundTaskRow>()
  private readonly writer: ClaudeBackgroundTaskRowWriter
  private readonly openTurn: ReturnType<typeof createClaudeBackgroundTaskTurnOpener>
  private readonly overflowTerminalRows: ClaudeOverflowTerminalRows
  private readonly ledgers = new ClaudeBackgroundTaskLedgers()
  private readonly ids = new ClaudeSubagentIds()
  private readonly now: () => number
  private readonly taskInvocations: ClaudeTaskInvocations

  constructor(private readonly deps: ClaudeBackgroundTaskRowsDeps) {
    this.taskInvocations = deps.taskInvocations ?? new ClaudeTaskInvocations()
    this.now = deps.now ?? (() => Date.now())
    this.openTurn = createClaudeBackgroundTaskTurnOpener(deps.openOutputTurn, this.taskInvocations)
    this.writer = new ClaudeBackgroundTaskRowWriter(
      deps.sink,
      deps.turnScope,
      deps.onPersistenceFailure
    )
    this.overflowTerminalRows = new ClaudeOverflowTerminalRows(
      this.ledgers,
      this.now,
      (id, row, openOutputTurn) => this.writeRow(id, row, openOutputTurn)
    )
  }

  /** @internal Ledger sizes exposed for eviction tests. */
  get ledgerSizes(): ClaudeBackgroundTaskLedgerSizes & { readonly overflowTerminalRows: number } {
    return { ...this.ledgers.sizes, overflowTerminalRows: this.overflowTerminalRows.size }
  }

  /** Notification frames that already opened a wake turn; a redelivered one must not open another. */
  private readonly wakeFrames = new BoundedMap<string, true>({ maxEntries: 64 })

  /** Null outside observe so teardown writes cannot reopen a turn. */
  private journaling: { frame: Record<string, unknown>; observedAt: number } | null = null

  observe(message: Record<string, unknown>, observedAt: number = this.now()): boolean {
    this.taskInvocations.observe(message)
    this.journaling = { frame: message, observedAt }
    // Claude wakes the lead for any task the lead launched, rowless subagents included; open that turn at the notification, once per frame.
    const toolUseId =
      message.subtype === 'task_notification' ? taskAliasId(message.tool_use_id) : undefined
    const frameId = typeof message.uuid === 'string' ? message.uuid : undefined
    if (
      message.type === 'system' &&
      toolUseId &&
      this.deps.isForwardedParentTool(toolUseId) &&
      !(frameId && this.wakeFrames.has(frameId))
    ) {
      if (frameId) {
        this.wakeFrames.set(frameId, true)
      }
      const id = canonicalClaudeBackgroundTaskId(message, this.ids)
      this.openTurn(this.journaling, true, id)()
    }
    try {
      return this.observeFrame(message)
    } finally {
      this.journaling = null
    }
  }

  /** Monitor results may precede announcements; their notifications belong to the tool call. */
  observeMonitorToolResult(taskId: unknown, toolUseId?: string): void {
    const id = taskAliasId(taskId)
    if (id !== undefined) {
      this.taskInvocations.excludeMonitor(id, toolUseId)
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
      observeOwnedClaudeBackgroundTaskRoster({
        tasks: message.tasks,
        rows: this.rows,
        invocations: this.taskInvocations,
        revise: (id, change) => this.revise(id, change),
        attribute: attributeClaudeBackgroundTaskRow,
        admit: (id, task) => {
          if (!this.ledgers.terminalTaskIds.has(id)) {
            this.observeStart(id, task, true)
          }
        }
      })
      return true
    }
    if (
      typeof message.subtype !== 'string' ||
      !CLAUDE_BACKGROUND_TASK_ROW_SUBTYPES.has(message.subtype)
    ) {
      return false
    }
    const id = canonicalClaudeBackgroundTaskId(message, this.ids)
    if (id === null) {
      return false
    }
    const selected = this.taskInvocations.selection(message, id)
    if (selected?.invocation.excluded || selected?.invocation.monitor) {
      return true
    }
    if (selected?.current === false) {
      if (message.subtype !== 'task_notification') {
        return true
      }
      const generation = this.ledgers.generations.next(id)
      const row = newClaudeBackgroundTaskRowFromNotification(id, message, this.now(), generation)
      row.invocation = selected.invocation
      this.writeRow(id, row)
      return true
    }
    if (message.subtype === 'task_started') {
      return this.observeStart(id, message)
    }
    if (this.ledgers.foreign.has(id)) {
      return true
    }
    if (!this.rows.has(id) && this.deps.rosteredByEarlierRun?.(id) === true) {
      this.ledgers.rememberForeign(id, 'roster')
      return true
    }
    if (message.subtype === 'task_notification') {
      return this.observeNotification(id, message)
    }
    return this.observePatch(id, message)
  }

  private observeStart(id: string, message: Record<string, unknown>, roster = false): boolean {
    const selected = this.taskInvocations.selection(message, id)
    if (!selected?.acceptsStart || selected.invocation.excluded || selected.invocation.monitor) {
      return true
    }
    return observeClaudeBackgroundTaskStart({
      id,
      message: {
        ...message,
        ...(roster ? { is_backgrounded: true } : {}),
        tool_use_id: selected.invocation.toolUseId
      },
      owned: selected.invocation.parentTaskId !== undefined,
      rows: this.rows,
      ledgers: this.ledgers,
      isForwardedParentTool: this.deps.isForwardedParentTool,
      openRow: (taskId, frame) => this.openRow(taskId, frame),
      refresh: (id) => this.write(id),
      maxRows: MAX_TASK_ROWS
    })
  }

  settleSession(): void {
    for (const [id, row] of this.rows) {
      if (!isSettledBackgroundTaskState(row.block.state)) {
        this.revise(id, { state: 'unverifiable' }, true)
      }
    }
    this.writer.settlePendingWrites()
  }

  dispose(): void {
    this.settleSession()
    this.rows.clear()
    this.writer.dispose()
    this.overflowTerminalRows.clear()
    this.ledgers.clear()
    this.ids.clear()
  }

  retryPendingWrites = () => this.writer.retryPendingWrites()

  private openRow(id: string, message: Record<string, unknown>): void {
    const generation = this.ledgers.generations.next(id)
    const row = newClaudeBackgroundTaskRow(id, message, this.now(), generation)
    row.invocation = this.taskInvocations.get(id, claudeBackgroundTaskToolUseId(message))
    this.rows.set(id, row)
    this.write(id)
  }

  private observeNotification(id: string, message: Record<string, unknown>): boolean {
    if (this.ledgers.fallbackTaskIds.has(id)) {
      this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
      this.overflowTerminalRows.observeNotification(id, message)
      return true
    }
    const row = this.rows.get(id)
    if (row && row.terminalNotificationReceived) {
      return true
    }
    // Remember terminal evidence even without admission so late announcements cannot resurrect work.
    this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
    if (!row) {
      return this.openTerminalRow(id, message)
    }
    const wasLive = !isSettledBackgroundTaskState(row.block.state)
    finalizeClaudeBackgroundTaskRow(row, message, this.now())
    this.write(id, wasLive)
    return true
  }

  // A terminal frame supplies its own outcome; a retained row only enriches it.
  private openTerminalRow(id: string, message: Record<string, unknown>): boolean {
    if (!ensureClaudeBackgroundTaskRowSlot(this.rows, MAX_TASK_ROWS)) {
      this.overflowTerminalRows.observeNotificationWithoutSlot(id, message)
      return true
    }
    const generation = this.ledgers.generations.next(id)
    const row = newClaudeBackgroundTaskRowFromNotification(id, message, this.now(), generation)
    row.invocation = this.taskInvocations.get(id, claudeBackgroundTaskToolUseId(message))
    this.rows.set(id, row)
    this.write(id)
    return true
  }

  private observePatch(id: string, message: Record<string, unknown>): boolean {
    if (this.ledgers.fallbackTaskIds.has(id)) {
      const change = claudeBackgroundTaskPatchChange(message)
      if (change.state && isSettledBackgroundTaskState(change.state)) {
        this.taskInvocations.settleFrame(id, message)
        this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
        this.overflowTerminalRows.observePatch(id, message, change)
        return true
      }
      return false
    }
    const row = this.rows.get(id)
    if (row && isSettledBackgroundTaskState(row.block.state)) {
      return true
    }
    const patch = record(message.patch)
    // Retain ownership of admitted rows even if later patches mark the task foreground.
    if (patch?.is_backgrounded === false && !this.rows.has(id)) {
      this.ledgers.rememberForeign(id, 'foreground')
      return true
    }
    const change = claudeBackgroundTaskPatchChange(message)
    if (change.state && isSettledBackgroundTaskState(change.state)) {
      this.taskInvocations.settleFrame(id, message)
      this.ledgers.rememberTerminal(this.rows, id, claudeBackgroundTaskToolUseId(message))
    }
    if (row) {
      this.revise(id, change)
    }
    return true
  }

  private revise(id: string, change: ClaudeBackgroundTaskChange, lifecycle = false): void {
    const row = this.rows.get(id)
    if (!row) {
      return
    }
    const wasLive = !isSettledBackgroundTaskState(row.block.state)
    reviseClaudeBackgroundTaskRow(row, change, this.now())
    this.write(id, wasLive, lifecycle)
  }

  private write(id: string, openOutputTurn = true, lifecycle = false): void {
    const row = this.rows.get(id)
    if (!row) {
      return
    }
    this.writeRow(id, row, openOutputTurn, lifecycle)
  }

  private writeRow(
    id: string,
    row: ClaudeBackgroundTaskRow,
    openOutputTurn = true,
    lifecycle = false
  ): void {
    attributeClaudeBackgroundTaskRow(id, row)
    this.writer.write(id, row, this.openTurn(this.journaling, openOutputTurn, id, row), lifecycle)
  }
}
