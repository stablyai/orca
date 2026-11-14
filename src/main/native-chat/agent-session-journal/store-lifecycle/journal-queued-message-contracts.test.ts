import { afterEach, describe, vi } from 'vitest'
import { registerJournalPiContextImportTests } from '../history-import/journal-pi-context-import.spec'
import { registerJournalProducerInheritanceTests } from '../projection/journal-producer-inheritance.spec'
import { registerJournalUnsentSendHoldTests } from '../queued-messages/journal-unsent-send-hold.spec'
import { registerQueuedMessagePauseTests } from '../queued-messages/queued-message-pause.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-pi-context-import', registerJournalPiContextImportTests)
describe('journal-producer-inheritance', registerJournalProducerInheritanceTests)
describe('journal-unsent-send-hold', registerJournalUnsentSendHoldTests)
describe('queued-message-pause', registerQueuedMessagePauseTests)
