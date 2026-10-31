import {
  admitOutcomeFormat2,
  JOURNAL_OUTCOME_FORMAT_2,
  isNativeOutcomeField,
  decodeNativeOutcome
} from './journal-outcome-format-2'
import { z } from 'zod'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalEntryChange } from './journal-transition-collections'
import { journalEntryJson, journalStateScalars } from './journal-state-layout'
import {
  admitOutcomeFormat1,
  JOURNAL_OUTCOME_FORMAT_1,
  type AdmittedOutcome
} from './journal-outcome-format-1'
import { decodeOutcomeFormat1Onto } from './journal-outcome-format-1-decode'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalOutcome = {
  seq: number
  field: string
  key: string
  format: number
  ordinal: string
  json: string
  deleted: boolean
}

/** A key first written over a frozen input prefix keeps the place the prefix gave it. */
export const JOURNAL_PREFIX_ORDINAL = 'b'

/** Stored outcome content this build rejects; storage errors never become this, so they stay
 * retryable, as main's replay keeps them. */
export class JournalOutcomeDecodeError extends Error {
  override readonly name = 'JournalOutcomeDecodeError'
}

const scalars = (state: JournalReducerState): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(journalStateScalars(state)))

/** Encoding freezes a sequence's contributions before the next input can mutate the draft;
 * `untracked` reads each changed value as it stands, not through the draft's tracking. */
export function encodeJournalOutcomes(
  state: JournalReducerState,
  changes: readonly JournalEntryChange[],
  before: Record<string, unknown>,
  untracked: (key: string, value: unknown) => unknown
): { values: Omit<JournalOutcome, 'ordinal'>[]; scalars: Record<string, unknown> } {
  const next = scalars(state)
  const values = changes.map((entry) => ({
    seq: state.lastSequence,
    field: entry.path,
    key: JSON.stringify(entry.key),
    format: JOURNAL_OUTCOME_FORMAT_2,
    json: entry.deleted
      ? 'null'
      : entry.path === 'items'
        ? JSON.stringify(entry.value, untracked)
        : journalEntryJson(entry.key, entry.value, untracked),
    deleted: entry.deleted
  }))
  for (const [key, value] of Object.entries(next)) {
    // The sequence is the record's own, and the epoch's coverage on read; it is never stored.
    if (key !== 'lastSequence' && JSON.stringify(value) !== JSON.stringify(before[key])) {
      values.push({
        seq: state.lastSequence,
        field: '$',
        key: JSON.stringify(key),
        format: JOURNAL_OUTCOME_FORMAT_2,
        json: JSON.stringify(value),
        deleted: false
      })
    }
  }
  for (const value of values) {
    // A reducer field format 1 has no home for needs a new outcome format, never a silent change.
    if (admitOutcomeFormat2(value) === 'unknown') {
      throw new Error(`journal outcome format 2 does not store ${value.field} ${value.key}`)
    }
  }
  return { values, scalars: next }
}

export function journalOutcomeScalars(state: JournalReducerState): Record<string, unknown> {
  return scalars(state)
}

/** Admits one stored record or refuses the chat: a newer format or field as newer, anything else as
 * damage. */
export function decodeJournalOutcome(row: SqliteRow): JournalOutcome {
  return admitJournalOutcome(row).value
}

function admitJournalOutcome(row: SqliteRow): { value: JournalOutcome; admitted: AdmittedOutcome } {
  return decodingOutcome(() => {
    if (
      typeof row.seq !== 'number' ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      typeof row.field !== 'string' ||
      typeof row.entry_key !== 'string' ||
      typeof row.format !== 'number' ||
      !Number.isSafeInteger(row.format) ||
      row.format < 1 ||
      typeof row.ordinal !== 'string' ||
      !/^(b|s\d{16}:\d{16})$/.test(row.ordinal) ||
      typeof row.value_json !== 'string' ||
      (row.deleted !== 0 && row.deleted !== 1)
    ) {
      throw new Error('invalid journal outcome')
    }
    const value = {
      seq: row.seq,
      field: row.field,
      key: row.entry_key,
      format: row.format,
      ordinal: row.ordinal,
      json: row.value_json,
      deleted: row.deleted === 1
    }
    const admitted =
      value.format === JOURNAL_OUTCOME_FORMAT_1
        ? admitOutcomeFormat1(value)
        : value.format === JOURNAL_OUTCOME_FORMAT_2
          ? admitOutcomeFormat2(value)
          : 'unknown'
    if (admitted === 'unknown') {
      throw new AgentSessionJournalError('journal_read_only', 'the chat holds a newer outcome')
    }
    return { value, admitted }
  })
}

/** A pure decode: a newer writer's record is refused as newer, anything else it throws is damage. */
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

type Newest = AdmittedOutcome & Pick<JournalOutcome, 'ordinal' | 'deleted'>

/** Last-write-wins per key, deletions included, so the tail can remove values from a frozen prefix;
 * order comes from the canonical log. */
export class JournalOutcomeFold {
  private readonly values = new Map<string, Map<string, Newest>>()
  /** Admits one stored record and keeps its value as admission parsed it, not its text. */
  add(row: SqliteRow): Pick<JournalOutcome, 'field' | 'key'> {
    const { value, admitted } = admitJournalOutcome(row)
    let field = this.values.get(value.field)
    if (!field) {
      field = new Map()
      this.values.set(value.field, field)
    }
    field.set(value.key, { ordinal: value.ordinal, deleted: value.deleted, ...admitted })
    return value
  }

  introduction(field: string, id: string): number | undefined {
    const ordinal = this.values.get(field)?.get(JSON.stringify(id))?.ordinal
    return ordinal?.startsWith('s') ? Number(ordinal.slice(1, 17)) : undefined
  }

  replaced(field: string, id: string): boolean {
    const value = this.values.get(field)?.get(JSON.stringify(id))
    return Boolean(value && (value.deleted || value.ordinal !== JOURNAL_PREFIX_ORDINAL))
  }

  /** Applies the latest values over `baseline` (the folded input prefix) or over the scalars alone:
   * a deletion removes, a prefix-ordinal value replaces in place, and every other value takes its
   * canonical place after the prefix. Each record was admitted as format 1 on read. A prefix-ordinal
   * value the prefix does not hold is still the key's newest value and is appended rather than
   * refusing the chat; that can only happen if the prefix is read differently from how it was
   * written, which the marker's rule forbids (`JOURNAL_OUTCOME_MARKER_VERSION`). */
  finish(
    sessionId: string,
    epoch: string,
    through: number,
    baseline?: JournalReducerState
  ): JournalReducerState {
    const scalars: [string, unknown][] = [
      ...[...(this.values.get('$')?.values() ?? [])].map((value): [string, unknown] => [
        String(value.entryKey),
        value.kept
      ]),
      ['lastSequence', through]
    ]
    const decode = decodingOutcome(() => decodeOutcomeFormat1Onto(scalars, baseline))
    for (const [field, entries] of this.values) {
      if (field === '$' || isNativeOutcomeField(field)) {
        continue
      }
      // Canonical ordinals compare bytewise, as SQLite's BINARY collation orders them; the prefix
      // ordinal sorts before every appended one.
      const ordered = [...entries.values()].sort((a, b) => (a.ordinal < b.ordinal ? -1 : 1))
      for (const value of ordered) {
        decodingOutcome(() => {
          if (value.deleted || value.ordinal !== JOURNAL_PREFIX_ORDINAL) {
            decode.remove(field, value.entryKey)
          }
          if (!value.deleted) {
            decode.entry(field, value.kept)
          }
        })
      }
    }
    const state = decode.finish()
    for (const [field, entries] of this.values) {
      if (!isNativeOutcomeField(field)) {
        continue
      }
      const ordered = [...entries.values()].sort((a, b) =>
        a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0
      )
      for (const value of ordered) {
        decodingOutcome(() =>
          decodeNativeOutcome(state, field, value.entryKey, value.kept, value.deleted)
        )
      }
    }
    if (state.sessionId !== sessionId || state.epoch !== epoch) {
      throw new JournalOutcomeDecodeError('invalid journal outcome coverage')
    }
    return state
  }
}
