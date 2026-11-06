import { afterEach, describe, vi } from 'vitest'
import { registerJournalUnknownRowKindTests } from './journal-unknown-row-kind.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-unknown-row-kind', registerJournalUnknownRowKindTests)
