import { z } from 'zod'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalEntryChange } from './journal-transition-collections'
import { journalEntryJson, journalStateScalars } from './journal-state-layout'
import { validateOutcomeFormat1 } from './journal-outcome-format-1'
import { startOutcomeFormat1Decode } from './journal-outcome-format-1-decode'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalOutcome = {
  seq: number
  field: string
  key: string
  ordinal: string
  json: string
  deleted: boolean
}

/** Stored outcome content this build rejects; storage errors never become this, so they stay
 * retryable, as main's replay keeps them. */
export class JournalOutcomeDecodeError extends Error {
  override readonly name = 'JournalOutcomeDecodeError'
}

const scalars = (state: JournalReducerState): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(journalStateScalars(state)))

/** Encoding freezes a sequence's contributions before the next input can mutate the draft. */
export function encodeJournalOutcomes(
  state: JournalReducerState,
  changes: readonly JournalEntryChange[],
  before: Record<string, unknown>
): { values: Omit<JournalOutcome, 'ordinal'>[]; scalars: Record<string, unknown> } {
  const next = scalars(state)
  const values = changes.map((entry) => ({
    seq: state.lastSequence,
    field: entry.path,
    key: JSON.stringify(entry.key),
    json: entry.deleted
      ? 'null'
      : entry.path === 'items'
        ? JSON.stringify(entry.value)
        : journalEntryJson(entry.key, entry.value),
    deleted: entry.deleted
  }))
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) {
      values.push({
        seq: state.lastSequence,
        field: '$',
        key: JSON.stringify(key),
        json: JSON.stringify(value),
        deleted: false
      })
    }
  }
  for (const value of values) {
    // A reducer field format 1 has no home for needs a new outcome format, never a silent change.
    if (validateOutcomeFormat1(value) === 'unknown') {
      throw new Error(`journal outcome format 1 does not store ${value.field} ${value.key}`)
    }
  }
  return { values, scalars: next }
}

export function journalOutcomeScalars(state: JournalReducerState): Record<string, unknown> {
  return scalars(state)
}

export function decodeJournalOutcome(row: SqliteRow): JournalOutcome {
  return decodingOutcome(() => {
    if (
      typeof row.seq !== 'number' ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      typeof row.field !== 'string' ||
      typeof row.entry_key !== 'string' ||
      typeof row.ordinal !== 'string' ||
      !/^s\d{16}:\d{16}$/.test(row.ordinal) ||
      typeof row.value_json !== 'string' ||
      (row.deleted !== 0 && row.deleted !== 1)
    ) {
      throw new Error('invalid journal outcome')
    }
    const value = {
      seq: row.seq,
      field: row.field,
      key: row.entry_key,
      ordinal: row.ordinal,
      json: row.value_json,
      deleted: row.deleted === 1
    }
    if (validateOutcomeFormat1(value) === 'unknown') {
      throw new AgentSessionJournalError(
        'journal_read_only',
        'the chat holds a newer outcome field'
      )
    }
    return value
  })
}

/** A pure decode: a newer writer's field is refused as newer, anything else it throws is damage. */
export function decodingOutcome<T>(decode: () => T): T {
  try {
    return decode()
  } catch (error) {
    if (error instanceof AgentSessionJournalError || error instanceof JournalOutcomeDecodeError) {
      throw error
    }
    throw new JournalOutcomeDecodeError('invalid journal outcome', { cause: error })
  }
}

/** Last-write-wins stores only whole current values; order comes from the canonical log. */
export class JournalOutcomeFold {
  private readonly values = new Map<string, Map<string, JournalOutcome>>()
  add(value: JournalOutcome): void {
    let field = this.values.get(value.field)
    if (!field) {
      field = new Map()
      this.values.set(value.field, field)
    }
    if (value.deleted) {
      field.delete(value.key)
    } else {
      field.set(value.key, value)
    }
  }

  /** journalOutcomeSource admits only format 1, so every fold decodes as format 1. */
  *finishPages(
    sessionId: string,
    epoch: string,
    through: number
  ): Generator<void, JournalReducerState> {
    const decode = decodingOutcome(() =>
      startOutcomeFormat1Decode(
        Object.fromEntries(
          [...(this.values.get('$')?.values() ?? [])].map((value) => [
            JSON.parse(value.key),
            JSON.parse(value.json)
          ])
        )
      )
    )
    let bytes = 0
    let count = 0
    for (const [field, entries] of this.values) {
      if (field === '$') {
        continue
      }
      // Canonical ordinals compare bytewise, as SQLite's BINARY collation orders them.
      const ordered = [...entries.values()].sort((a, b) => (a.ordinal < b.ordinal ? -1 : 1))
      for (const value of ordered) {
        decodingOutcome(() =>
          field === 'items' ? decode.item(value.json) : decode.entry(field, value.json)
        )
        bytes += Buffer.byteLength(value.json)
        count += 1
        if (count >= 32 || bytes >= 1 << 20) {
          bytes = 0
          count = 0
          yield
        }
      }
    }
    const state = decode.finish()
    if (state.sessionId !== sessionId || state.epoch !== epoch || state.lastSequence !== through) {
      throw new JournalOutcomeDecodeError('invalid journal outcome coverage')
    }
    return state
  }

  finish(sessionId: string, epoch: string, through: number): JournalReducerState {
    const pages = this.finishPages(sessionId, epoch, through)
    let step = pages.next()
    while (!step.done) {
      step = pages.next()
    }
    return step.value
  }
}
