import { afterEach, describe, vi } from 'vitest'
import { registerJournalPiContextImportTests } from './journal-pi-context-import.spec'
import { registerJournalProducerInheritanceTests } from './journal-producer-inheritance.spec'
import { registerJournalUnsentSendHoldTests } from './journal-unsent-send-hold.spec'
import { registerQueuedMessagePauseTests } from './queued-message-pause.spec'
import { registerQueuedMessageUpdateTests } from './queued-message-update.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-pi-context-import', registerJournalPiContextImportTests)
describe('journal-producer-inheritance', registerJournalProducerInheritanceTests)
describe('journal-unsent-send-hold', registerJournalUnsentSendHoldTests)
describe('queued-message-pause', registerQueuedMessagePauseTests)
describe('queued-message-update', registerQueuedMessageUpdateTests)
