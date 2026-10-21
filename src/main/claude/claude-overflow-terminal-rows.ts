import {
  finalizeClaudeBackgroundTaskRow,
  newClaudeBackgroundTaskRow,
  newClaudeBackgroundTaskRowFromNotification,
  reviseClaudeBackgroundTaskRow,
  type ClaudeBackgroundTaskChange,
  type ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'
import type { ClaudeBackgroundTaskLedgers } from './claude-background-task-memory'

const MAX_OVERFLOW_TERMINAL_ROWS = 512

/** Settled rows waiting for their final notification never consume a live task slot. */
export class ClaudeOverflowTerminalRows {
  private readonly rows = new Map<string, ClaudeBackgroundTaskRow>()

  constructor(
    private readonly ledgers: ClaudeBackgroundTaskLedgers,
    private readonly now: () => number,
    private readonly write: (
      id: string,
      row: ClaudeBackgroundTaskRow,
      openOutputTurn?: boolean
    ) => void
  ) {}

  get size(): number {
    return this.rows.size
  }

  observePatch(
    id: string,
    message: Record<string, unknown>,
    change: ClaudeBackgroundTaskChange
  ): void {
    if (this.rows.has(id)) {
      return
    }
    const row = newClaudeBackgroundTaskRow(
      id,
      message,
      this.now(),
      this.ledgers.generations.next(id)
    )
    reviseClaudeBackgroundTaskRow(row, change, this.now())
    this.rows.set(id, row)
    this.write(id, row)
    while (this.rows.size > MAX_OVERFLOW_TERMINAL_ROWS) {
      const oldest = this.rows.keys().next()
      if (oldest.done) {
        break
      }
      this.rows.delete(oldest.value)
      this.ledgers.fallbackTaskIds.delete(oldest.value)
      this.ledgers.rememberForeign(oldest.value, 'terminal')
    }
  }

  observeNotification(id: string, message: Record<string, unknown>): void {
    const row = this.rows.get(id)
    this.rows.delete(id)
    this.ledgers.fallbackTaskIds.delete(id)
    if (row) {
      finalizeClaudeBackgroundTaskRow(row, message, this.now())
      this.write(id, row, false)
    } else {
      this.writeNotification(id, message)
    }
    this.ledgers.rememberForeign(id, 'terminal')
  }

  observeNotificationWithoutSlot(id: string, message: Record<string, unknown>): void {
    this.writeNotification(id, message)
    this.ledgers.rememberForeign(id, 'terminal')
  }

  clear(): void {
    this.rows.clear()
  }

  private writeNotification(id: string, message: Record<string, unknown>): void {
    this.write(
      id,
      newClaudeBackgroundTaskRowFromNotification(
        id,
        message,
        this.now(),
        this.ledgers.generations.next(id)
      )
    )
  }
}
