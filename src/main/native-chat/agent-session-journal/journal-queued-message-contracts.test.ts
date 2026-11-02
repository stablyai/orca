import { afterEach, describe, vi } from 'vitest'
import { registerJournalPiContextImportTests } from './journal-pi-context-import.spec'
import { registerJournalProducerInheritanceTests } from './journal-producer-inheritance.spec'
import { registerJournalUnsentSendHoldTests } from './journal-unsent-send-hold.spec'
import { registerQueuedMessageBookkeepingFailureTests } from './queued-message-bookkeeping-failure.spec'
import { registerQueuedMessageDeliveredEchoTests } from './queued-message-delivered-echo.spec'
import { registerQueuedMessagePauseTests } from './queued-message-pause.spec'
import { registerQueuedMessageStoreTests } from './queued-message-store.spec'
import { registerQueuedMessageTextUpdateTests } from './queued-message-text-update.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-pi-context-import', registerJournalPiContextImportTests)
describe('journal-producer-inheritance', registerJournalProducerInheritanceTests)
describe('journal-unsent-send-hold', registerJournalUnsentSendHoldTests)
describe('queued-message-bookkeeping-failure', registerQueuedMessageBookkeepingFailureTests)
describe('queued-message-delivered-echo', registerQueuedMessageDeliveredEchoTests)
describe('queued-message-pause', registerQueuedMessagePauseTests)
describe('queued-message-store', registerQueuedMessageStoreTests)
describe('queued-message-text-update', registerQueuedMessageTextUpdateTests)
