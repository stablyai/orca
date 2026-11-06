import { afterEach, describe, vi } from 'vitest'
import { registerCommandReceiptSchemaTests } from '../writing/command-receipt-schema.spec'
import { registerCommandReceiptTableTests } from '../writing/command-receipt-table.spec'
import { registerCommandReceiptTransactionTests } from '../writing/command-receipt-transaction.spec'
import { registerJournalDatabaseTests } from '../database/journal-database.spec'
import { registerJournalHostDatabaseTests } from '../database/journal-host-database.spec'
import { registerJournalRowWriterTests } from '../writing/journal-row-writer.spec'
import { registerJournalWriteQueueTests } from '../writing/journal-write-queue.spec'
import { registerJournalRowSchemaVersionTests } from '../durable-rows/journal-row-schema-version.spec'

afterEach(() => vi.restoreAllMocks())

describe('command-receipt-schema', registerCommandReceiptSchemaTests)
describe('command-receipt-table', registerCommandReceiptTableTests)
describe('command-receipt-transaction', registerCommandReceiptTransactionTests)
describe('journal-database', registerJournalDatabaseTests)
describe('journal-host-database', registerJournalHostDatabaseTests)
describe('journal-row-writer', registerJournalRowWriterTests)
describe('journal-write-queue', registerJournalWriteQueueTests)
describe('journal-row-schema-version', registerJournalRowSchemaVersionTests)
