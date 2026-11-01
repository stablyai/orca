import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type {
  AgentMessageSource,
  AgentSessionMessageSource
} from '../../../shared/agent-session/agent-session-message-source'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { holdUnsentSends, type UnsentSendHold } from './journal-unsent-send-hold'
import type { AgentSessionJournal } from './journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from './journal-host-database-test-support'

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
    return holdUnsentSends(journal, { fence: 0, hold: settle })
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

  async function storeSubmissionSourceAs(
    journal: AgentSessionJournal,
    id: string,
    source: unknown
  ): Promise<void> {
    await journal.close()
    const seq = journal.submission(id)?.submittedSequence
    const { db } = openTestJournalHostDatabase(root)
    const stored = liveTestJournalRows(db, IDENTITY.sessionId).find((row) => row.seq === seq)
    if (!stored) {
      throw new Error(`no stored row for ${id}`)
    }
    const row: unknown = JSON.parse(stored.rowJson)
    updateTestJournalRowJson(
      db,
      IDENTITY.sessionId,
      stored.seq,
      JSON.stringify({ ...(typeof row === 'object' ? row : {}), source })
    )
  }

  function cardOrder(journal: AgentSessionJournal): string[] {
    return journal.queuedMessages
      .list()
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
    journals,
    message,
    open,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    storeSubmissionSourceAs
  }
}
