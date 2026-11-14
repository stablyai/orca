import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentMessageSource,
  AgentSessionMessageSource
} from '../../../../shared/agent-session/agent-session-message-source'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type { JournalWriterOperation } from '../journal-writer-command'
type UnsentSendHold = Extract<JournalWriterOperation, { kind: 'hold-unsent' }>['hold']
import type { AgentSessionJournal } from '../journal-store'
import type { JournalRow, JournalSubmissionRow } from '../durable-rows/journal-row-schema'
import type { JournalQueueRow } from './journal-queue-events'
import { seedTestJournalHistoricalRows } from '../replay/journal-historical-inputs.test-support'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../store-lifecycle/journal-host-database-test-support'

export function createFixture() {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-held',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('native-1', null)
  }

  const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
    surface: 'rejection'
  })

  const CHAT_CLOSED = agentSessionFailureWords(agentSessionFailureFact('chatClosed'), {
    surface: 'rejection'
  })

  let root: string

  let clock = 1_000

  let epochs = 0

  const journals = createTrackedJournalOpener({ legacyInputs: true })

  function message(text: string): AgentJournalMessageItem {
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }

  function fingerprint(body: AgentJournalMessageItem): string {
    return structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: IDENTITY.sessionId,
      fields: { body }
    })
  }

  async function open(): Promise<AgentSessionJournal> {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => (clock += 1),
      mintEpoch: () => `epoch-${(epochs += 1)}`
    })
  }

  function hold(journal: AgentSessionJournal, settle: UnsentSendHold = { cause: 'hostRestarted' }) {
    return journal.write({ kind: 'hold-unsent', fence: 0, hold: settle })
  }

  const MAIL_SOURCE: AgentMessageSource = {
    kind: 'agent',
    senders: [
      {
        party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
        name: null
      }
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'agent:worker',
      dispatchId: null,
      messages: []
    }
  }

  async function accept(
    journal: AgentSessionJournal,
    id: string,
    fields: {
      body?: AgentJournalMessageItem
      origin?: 'client' | 'host'
      source?: AgentSessionMessageSource
    } = {}
  ): Promise<void> {
    const body = fields.body ?? message(`text of ${id}`)
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: fingerprint(body),
      body,
      fence: 0,
      handoverRecorded: true,
      ...(fields.origin ? { origin: fields.origin } : {}),
      ...(fields.source ? { source: fields.source } : {})
    })
  }

  async function afterRestart(
    write: (journal: AgentSessionJournal) => Promise<void>
  ): Promise<AgentSessionJournal> {
    const earlier = await open()
    await write(earlier)
    await earlier.close()
    return open()
  }

  const historicalBase = (seq: number) => ({
    v: 4,
    epoch: 'old-queue',
    seq,
    fence: 0,
    ts: 1_000 + seq
  })
  function historicalQueue(
    seq: number,
    messageId: string,
    body = message(messageId),
    position = seq
  ): JournalQueueRow {
    return {
      ...historicalBase(seq),
      kind: 'queue',
      messageId,
      change: { op: 'queued', body, position, queuedAt: { epoch: 'old-queue', sequence: seq } }
    }
  }
  function historicalSend(
    seq: number,
    clientMessageId: string,
    fields: Partial<JournalSubmissionRow> = {}
  ): JournalSubmissionRow {
    const body = fields.body ?? message(clientMessageId)
    return {
      ...historicalBase(seq),
      kind: 'submission',
      clientMessageId,
      body,
      payloadFingerprint: fingerprint(body),
      providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null },
      origin: 'client',
      source: { kind: 'user' },
      handoverRecorded: true,
      ...fields
    }
  }
  async function openHistorical(rows: JournalRow[]) {
    seedTestJournalHistoricalRows(openTestJournalHostDatabase(root).db, IDENTITY, [
      {
        ...historicalBase(1),
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
      },
      ...rows
    ])
    return open()
  }

  async function cardOrder(journal: AgentSessionJournal): Promise<string[]> {
    return (await journal.queuedMessages.list())
      .filter((card) => card.state === 'waiting')
      .map((card) => card.messageId)
  }

  beforeEach(async () => {
    epochs = 0
    root = await mkdtemp(join(tmpdir(), 'orca-unsent-hold-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  return {
    CHAT_CLOSED,
    HOST_RESTARTED,
    IDENTITY,
    MAIL_SOURCE,
    accept,
    afterRestart,
    cardOrder,
    get clock() {
      return clock
    },
    set clock(value: typeof clock) {
      clock = value
    },
    get epochs() {
      return epochs
    },
    set epochs(value: typeof epochs) {
      epochs = value
    },
    fingerprint,
    hold,
    historicalBase,
    historicalQueue,
    historicalSend,
    openHistorical,
    journals,
    message,
    open,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    }
  }
}
