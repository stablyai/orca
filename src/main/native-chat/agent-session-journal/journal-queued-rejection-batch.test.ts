// A failed start's row and the queued message it failed land in ONE append, the message first: no
// reader meets one without the other, the message sits above the row that says why, and a message
// queued behind it is left for its own start.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionJournal } from './journal-store'
import { MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from './journal-row-schema'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-start',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}

const START_FAILED = agentSessionFailureWords(agentSessionFailureFact('providerStartFailed'), {
  surface: 'rejection'
})
const ERROR_ROW = { provider: 'orca', clientMessageId: 'start-failure:first' } as const

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
    settlementId: 'start-failure:first',
    fence: 0,
    recovered: true as const,
    mutations: Array.from({ length: mutations }, () => ({
      kind: 'item' as const,
      identity: ERROR_ROW,
      body: { kind: 'status' as const, tone: 'error' as const, text: 'Claude did not start.' },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })),
    rejects: { ...START_FAILED, clientMessageId: 'first', which: isQueuedAgentJournalSubmission }
  }
}

it('writes the rejection first and the row right after it, leaving the message behind it queued', async () => {
  const journal = await openWithQueued('first', 'second')
  const before = journal.cursor().sequence

  await journal.appendLifecycleBatch(startFailureBatch())

  expect(journal.cursor().sequence).toBe(before + 2)
  expect(journal.submissions().map((entry) => entry.dispatchState)).toEqual(['rejected', 'pending'])
  const placed = new Map(journal.snapshot().items.map((item) => [item.itemId, item]))
  const message = placed.get(agentJournalSubmissionKey('first'))
  const row = placed.get('orca:start-failure%3Afirst')
  // One write: the row is the next row after the rejection, at the same instant.
  expect(row?.sequence).toBe((message?.sequence ?? 0) + 1)
  expect(row?.observedAt).toBe(message?.observedAt)
})

it('writes neither when the row cannot be written', async () => {
  const journal = await openWithQueued('first')
  const before = journal.cursor().sequence

  // A batch over the row's bound fails to build, so the transaction rolls back as a whole.
  await expect(
    journal.appendLifecycleBatch(startFailureBatch(MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS + 1))
  ).rejects.toThrow('journal_lifecycle_batch_mutation_bound_exceeded')

  expect(journal.cursor().sequence).toBe(before)
  expect(journal.submissions().map((entry) => entry.dispatchState)).toEqual(['pending'])
})

// A start failing as its run's row already says rejects its message and writes no row.
it('writes only the rejection when the batch carries no row', async () => {
  const journal = await openWithQueued('first', 'second')
  const before = journal.cursor().sequence

  await journal.appendLifecycleBatch(startFailureBatch(0))

  expect(journal.cursor().sequence).toBe(before + 1)
  expect(journal.submissions().map((entry) => entry.dispatchState)).toEqual(['rejected', 'pending'])
  expect(journal.snapshot().items.map((item) => item.itemId)).not.toContain(
    'orca:start-failure%3Afirst'
  )
})

// A Stop that reaches the lane first takes the message back; the failed start then failed no one.
it('writes nothing when a Stop withdrew the message first', async () => {
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
