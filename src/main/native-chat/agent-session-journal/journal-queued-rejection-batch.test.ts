// A failed start's row and the queued messages it failed land in ONE append, the messages first:
// no reader meets one without the other, and the messages sit above the row that says why.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-start',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}

const START_FAILED = agentSessionFailureWords(agentSessionFailureFact('providerStartFailed'), {
  surface: 'rejection'
})
const ERROR_ROW = { provider: 'orca', clientMessageId: 'start-failure:gen-1' } as const

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-rejection-batch-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function openWithQueued(...ids: string[]): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
  for (const id of ids) {
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: `fp-${id}`,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      fence: 0,
      handoverRecorded: true
    })
  }
  return journal
}

function startFailureBatch(mutations = 1) {
  return {
    settlementId: 'start-failure:gen-1',
    fence: 0,
    recovered: true as const,
    mutations: Array.from({ length: mutations }, () => ({
      kind: 'item' as const,
      identity: ERROR_ROW,
      body: { kind: 'status' as const, tone: 'error' as const, text: 'Claude did not start.' },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })),
    rejectsQueued: START_FAILED
  }
}

it('writes the rejections first and the row after them, and draws the messages above it', async () => {
  const journal = await openWithQueued('first', 'second')
  const before = journal.cursor().sequence

  await journal.appendLifecycleBatch(startFailureBatch())

  expect(journal.cursor().sequence).toBe(before + 3)
  expect(journal.submissions().map((entry) => entry.dispatchState)).toEqual([
    'rejected',
    'rejected'
  ])
  const order = journal.snapshot().items.map((item) => item.itemId)
  expect(order).toEqual([
    agentJournalSubmissionKey('first'),
    agentJournalSubmissionKey('second'),
    'orca:start-failure%3Agen-1'
  ])
})

it('writes neither when the row cannot be written', async () => {
  const journal = await openWithQueued('first')
  const before = journal.cursor().sequence

  // An empty batch breaks the row's bound, so the transaction rolls back as a whole.
  await expect(journal.appendLifecycleBatch(startFailureBatch(0))).rejects.toThrow(
    'journal_lifecycle_batch_mutation_bound_exceeded'
  )

  expect(journal.cursor().sequence).toBe(before)
  expect(journal.submissions().map((entry) => entry.dispatchState)).toEqual(['pending'])
})

// A Stop that reaches the lane first takes the message back; the failed start then failed no one.
it('writes nothing when a Stop withdrew every queued message first', async () => {
  const journal = await openWithQueued('first')
  const withdrawal = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
    surface: 'rejection'
  })

  await Promise.all([
    journal.rejectQueuedSubmissions(0, withdrawal),
    journal.appendLifecycleBatch(startFailureBatch())
  ])

  expect(journal.submissions()[0]?.rejection).toEqual({ kind: 'cancelled' })
  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
    agentJournalSubmissionKey('first')
  ])
})
