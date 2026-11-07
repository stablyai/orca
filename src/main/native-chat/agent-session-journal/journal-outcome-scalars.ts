import type { JournalReducerState } from './projection/journal-reducer'

/** A saved scalar can be reused without decoding a growing value unchanged by this command. */
export class JournalEncodedScalar {
  constructor(private encoded: string | (() => string)) {}

  get json(): string {
    if (typeof this.encoded === 'function') {
      this.encoded = this.encoded()
    }
    return this.encoded
  }
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
