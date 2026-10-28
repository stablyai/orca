import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import { isSettledBackgroundTaskState } from '../../shared/native-chat/input/native-chat-background-task-row'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { record, taskAliasId } from './claude-background-task-frames'
import {
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
import { ClaudeBackgroundTaskRowWriter } from './claude-background-task-row-writer'
import { observeClaudeBackgroundTaskStart } from './claude-background-task-start'
import { observeClaudeBackgroundTaskRoster } from './claude-background-task-roster'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import { ClaudeOverflowTerminalRows } from './claude-overflow-terminal-rows'

const MAX_TASK_ROWS = 64

const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification'
])

const SILENT_ROW_REFRESH_SUBTYPES: ReadonlySet<string> = new Set([
  'task_progress',
  'background_tasks_changed'
])

export type ClaudeBackgroundTaskRowsDeps = {
  sink: StructuredAgentSessionEventSink
  /** Require a forwarded top-level invocation on first admission to exclude nested children. */
  isForwardedParentTool: (toolUseId: string) => boolean
  /** Recover earlier-run subagent ownership when Claude does not repeat its announcement. */
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
  private readonly overflowTerminalRows: ClaudeOverflowTerminalRows
  private readonly ledgers = new ClaudeBackgroundTaskLedgers()
  private readonly ids = new ClaudeSubagentIds()
  private readonly now: () => number

  constructor(private readonly deps: ClaudeBackgroundTaskRowsDeps) {
    this.now = deps.now ?? (() => Date.now())
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

  /** Null outside observe so teardown writes cannot reopen a turn. */
  private journaling: { frame: Record<string, unknown>; observedAt: number } | null = null

  observe(message: Record<string, unknown>, observedAt: number = this.now()): boolean {
    this.journaling = { frame: message, observedAt }
    try {
      return this.observeFrame(message)
    } finally {
      this.journaling = null
    }
  }

  /** Monitor results may precede announcements; their notifications belong to the tool call. */
  observeMonitorToolResult(taskId: unknown): void {
    const id = taskAliasId(taskId)
    if (id !== undefined) {
      this.ledgers.rememberForeign(id, 'ambient')
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
      observeClaudeBackgroundTaskRoster(message.tasks, this.rows, (id, change) =>
        this.revise(id, change)
      )
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
      return observeClaudeBackgroundTaskStart({
        id,
        message,
        rows: this.rows,
        ledgers: this.ledgers,
        isForwardedParentTool: this.deps.isForwardedParentTool,
        openRow: (taskId, frame) => this.openRow(taskId, frame),
        maxRows: MAX_TASK_ROWS
      })
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

  retryPendingWrites() {
    return this.writer.retryPendingWrites()
  }

  private openRow(id: string, message: Record<string, unknown>): void {
    const generation = this.ledgers.generations.next(id)
    this.rows.set(id, newClaudeBackgroundTaskRow(id, message, this.now(), generation))
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
    this.rows.set(
      id,
      newClaudeBackgroundTaskRowFromNotification(id, message, this.now(), generation)
    )
    this.write(id)
    return true
  }

  private observePatch(id: string, message: Record<string, unknown>): boolean {
    if (this.ledgers.fallbackTaskIds.has(id)) {
      const change = claudeBackgroundTaskPatchChange(message)
      if (change.state && isSettledBackgroundTaskState(change.state)) {
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
    const journaling = this.journaling
    this.writer.write(
      id,
      row,
      () => {
        // Why: progress and roster ticks refresh the row only. Opening a turn
        // here flips an idle chat back to working.
        const subtype = journaling?.frame.subtype
        if (
          journaling &&
          openOutputTurn &&
          (typeof subtype !== 'string' || !SILENT_ROW_REFRESH_SUBTYPES.has(subtype))
        ) {
          this.deps.openOutputTurn?.(journaling.frame, journaling.observedAt)
        }
      },
      lifecycle
    )
  }
}
