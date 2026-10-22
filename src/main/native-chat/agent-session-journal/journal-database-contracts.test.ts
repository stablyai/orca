import { afterEach, describe, vi } from 'vitest'
import { registerCommandReceiptSchemaTests } from './command-receipt-schema.spec'
import { registerCommandReceiptTableTests } from './command-receipt-table.spec'
import { registerCommandReceiptTransactionTests } from './command-receipt-transaction.spec'
import { registerJournalDatabaseTests } from './journal-database.spec'
import { registerJournalHostDatabaseTests } from './journal-host-database.spec'
import { registerJournalRowWriterTests } from './journal-row-writer.spec'
import { registerJournalWriteQueueTests } from './journal-write-queue.spec'
import { registerJournalStoreSchemaTests } from './journal-store-schema.spec'
import { registerJournalRowSchemaVersionTests } from './journal-row-schema-version.spec'

afterEach(() => vi.restoreAllMocks())

describe('command-receipt-schema', registerCommandReceiptSchemaTests)
describe('command-receipt-table', registerCommandReceiptTableTests)
describe('command-receipt-transaction', registerCommandReceiptTransactionTests)
describe('journal-database', registerJournalDatabaseTests)
describe('journal-host-database', registerJournalHostDatabaseTests)
describe('journal-row-writer', registerJournalRowWriterTests)
describe('journal-write-queue', registerJournalWriteQueueTests)
describe('journal-store-schema', registerJournalStoreSchemaTests)
describe('journal-row-schema-version', registerJournalRowSchemaVersionTests)
