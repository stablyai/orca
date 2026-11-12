import { afterEach, describe, vi } from 'vitest'
import { registerCommandReceiptSchemaTests } from '../writing/command-receipt-schema.spec'
import { registerCommandReceiptTableTests } from '../writing/command-receipt-table.spec'
import { registerJournalDatabaseTests } from '../database/journal-database.spec'
import { registerJournalWriteQueueTests } from '../writing/journal-write-queue.spec'

afterEach(() => vi.restoreAllMocks())

describe('command-receipt-schema', registerCommandReceiptSchemaTests)
describe('command-receipt-table', registerCommandReceiptTableTests)
describe('journal-database', registerJournalDatabaseTests)
describe('journal-write-queue', registerJournalWriteQueueTests)
