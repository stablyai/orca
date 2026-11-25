// A chat turn's identity on its status row: the lead's `stateStartedAt` stays pinned for a working
// run, so the dates a turn's row showed (its start, and each re-date of the same turn) name that turn.
// Once the turn ends they name the ended turn, so a row still showing one of them is that turn read
// again, never a new one. A real next turn shows its own date, whatever its clock.

import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import { conversationWorking, leadOf } from './external-conversation-turn-state'

// Re-dates of one turn are few; past this the oldest after the told start go.
const MAX_DATES = 16

export class TurnDates {
  private readonly open = new Map<string, number[]>()
  // The message that opened each open turn on its host, once seen: a re-date under another opener
  // is the host's next turn, never this one's.
  private readonly openers = new Map<string, string>()
  private readonly ended = new Map<string, ReadonlySet<number>>()
  // A turn a newer one replaced before its end was heard: the next end is its, not the newer one's.
  private readonly replaced = new Map<string, number[]>()

  /** A new turn begins on this date: the ended turn's dates no longer matter. */
  started(paneKey: string, at: number, opener?: string | null): void {
    const before = this.open.get(paneKey)
    // The open turn told again under its own date: still that turn.
    if (before?.includes(at)) {
      return
    }
    if (before) {
      this.replaced.set(paneKey, before)
    }
    this.open.set(paneKey, [at])
    this.ended.delete(paneKey)
    if (opener) {
      this.openers.set(paneKey, opener)
    } else {
      this.openers.delete(paneKey)
    }
  }

  /** The open turn's row shows this date too (its start re-dated, or a turn adopted mid-run). With
   *  `opener`, only while the host still runs the turn that message opened. */
  showed(paneKey: string, at: number, opener?: string | null): void {
    if (opener !== undefined) {
      const known = this.openers.get(paneKey)
      if (!opener || (known !== undefined && known !== opener)) {
        return
      }
      this.openers.set(paneKey, opener)
    }
    const dates = this.open.get(paneKey) ?? []
    if (!dates.includes(at)) {
      // The told start is kept; the oldest re-date after it goes first.
      const next = [...dates, at]
      this.open.set(
        paneKey,
        next.length > MAX_DATES ? next.slice(0, 1).concat(next.slice(1 - MAX_DATES)) : next
      )
    }
  }

  /** The open turn ended (or the one it replaced, whose end is still owed): its dates now name the
   *  ended turn. */
  endedTurn(paneKey: string): void {
    const replaced = this.replaced.get(paneKey)
    if (replaced) {
      this.replaced.delete(paneKey)
      this.ended.set(paneKey, new Set(replaced))
      return
    }
    const dates = this.open.get(paneKey)
    this.open.delete(paneKey)
    this.openers.delete(paneKey)
    if (dates) {
      this.ended.set(paneKey, new Set(dates))
    } else {
      this.ended.delete(paneKey)
    }
  }

  /** Whether a working row's date is the ended turn's. */
  isEnded(paneKey: string, at: number): boolean {
    return this.ended.get(paneKey)?.has(at) === true
  }

  /** Whether the chat's lead works on a turn now, not on the ended turn's row read again. */
  leadWorking(paneKey: string, row: AgentStatusIpcPayload | null): boolean {
    return conversationWorking(row) && !(row && this.isEnded(paneKey, leadOf(row).stateStartedAt))
  }

  forget(paneKey: string): void {
    this.open.delete(paneKey)
    this.replaced.delete(paneKey)
    this.openers.delete(paneKey)
    this.ended.delete(paneKey)
  }

  /** A watch went: no open turn is followed across the gap, but ended turns stay ended. */
  gap(): void {
    this.open.clear()
    this.openers.clear()
    this.replaced.clear()
  }

  clear(): void {
    this.open.clear()
    this.replaced.clear()
    this.openers.clear()
    this.ended.clear()
  }
}
