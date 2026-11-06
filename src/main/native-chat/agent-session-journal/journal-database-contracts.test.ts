import { afterEach, describe, vi } from 'vitest'
import { registerCommandReceiptSchemaTests } from './command-receipt-schema.spec'
import { registerCommandReceiptTableTests } from './command-receipt-table.spec'
import { registerJournalDatabaseTests } from './journal-database.spec'
import { registerJournalHostDatabaseTests } from './journal-host-database.spec'
import { registerJournalWriteQueueTests } from './journal-write-queue.spec'

afterEach(() => vi.restoreAllMocks())

describe('command-receipt-schema', registerCommandReceiptSchemaTests)
describe('command-receipt-table', registerCommandReceiptTableTests)
describe('journal-database', registerJournalDatabaseTests)
describe('journal-host-database', registerJournalHostDatabaseTests)
describe('journal-write-queue', registerJournalWriteQueueTests)
