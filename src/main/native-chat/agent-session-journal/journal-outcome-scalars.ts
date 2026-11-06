import type { JournalReducerState } from './journal-reducer'

/** A saved scalar can be reused without decoding a growing value unchanged by this command. */
export class JournalEncodedScalar {
  constructor(readonly json: string) {}
}

const readers = new WeakMap<JournalReducerState, () => Record<string, unknown>>()

export function setJournalOutcomeScalarReader(
  state: JournalReducerState,
  read: () => Record<string, unknown>
): void {
  readers.set(state, read)
}

export function readJournalOutcomeScalars(
  state: JournalReducerState
): Record<string, unknown> | undefined {
  return readers.get(state)?.()
}

export function journalOutcomeScalarJson(value: unknown): string | undefined {
  return value instanceof JournalEncodedScalar ? value.json : JSON.stringify(value)
}
