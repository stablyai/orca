import { afterEach, describe, vi } from 'vitest'
import { registerJournalUnknownRowKindTests } from '../durable-rows/journal-unknown-row-kind.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-unknown-row-kind', registerJournalUnknownRowKindTests)
