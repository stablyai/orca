// Whether a failed start's row repeats its run's is decided on the journal's lane, as the batch
// carrying it is planned: a send accepted ahead of it in that lane ends the run, however late the
// writer read the journal. Each case holds the lane with a write in progress and issues the others
// from inside it, so the lane, not timing, orders them.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  isStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRowIdentity
} from '../../../shared/structured-agent-session-start-failure-row-key'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from '../agent-session-journal/journal-host-database-test-support'
import {
  rejectWithStartFailureRow,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-settlement'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-run-lane',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}
const SIGNED_OUT = agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
  surface: 'rejection'
})
const NOTE = { provider: 'orca', clientMessageId: 'note' } as const

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-run-lane-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

/** A chat whose first queued message already failed its start, leaving the run's row. */
async function openAfterFailedStart(...queued: string[]): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
  for (const id of ['first', ...queued]) {
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: `fp-${id}`,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      fence: 0,
      handoverRecorded: true
    })
  }
  await reject(journal, 'first')
  return journal
}

function reject(journal: AgentSessionJournal, clientMessageId: string): Promise<void> {
  return rejectWithStartFailureRow(journal, {
    clientMessageId,
    words: SIGNED_OUT,
    fence: 0,
    which: isQueuedAgentJournalSubmission
  })
}

function accept(journal: AgentSessionJournal, clientMessageId: string): Promise<unknown> {
  return journal.resolveDispatch({
    clientMessageId,
    state: 'accepted',
    providerIdentity: {
      provider: 'claude',
      sessionId: 'native-1',
      uuid: `echo-${clientMessageId}`
    },
    fence: 0
  })
}

/** Runs `issue` from inside a write in progress, so whatever it issues joins the lane behind it. */
async function fromInsideAWrite(
  journal: AgentSessionJournal,
  issue: () => Promise<unknown>[]
): Promise<void> {
  let issued: Promise<unknown>[] = []
  await journal.appendResolvedItem(
    () => {
      issued = issue()
      return { identity: NOTE, body: { kind: 'status', tone: 'info', text: 'held' } }
    },
    { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await Promise.all(issued)
}

function startRows(journal: AgentSessionJournal): string[] {
  return journal
    .snapshot()
    .items.flatMap((item) =>
      isStructuredAgentSessionStartFailureRow(item.itemId) ? [item.itemId] : []
    )
}

const rowKey = (id: string) =>
  agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(id))

it('writes the row of a start failing alike when a send was accepted ahead of it in the lane', async () => {
  const journal = await openAfterFailedStart('delivered', 'second')

  // Both issued before either lands: the writer reads a journal with no accept in it yet.
  await fromInsideAWrite(journal, () => [accept(journal, 'delivered'), reject(journal, 'second')])

  expect(journal.submission('delivered')?.dispatchState).toBe('accepted')
  expect(journal.submission('second')?.dispatchState).toBe('rejected')
  expect(startRows(journal)).toEqual([rowKey('first'), rowKey('second')])
})

it('writes no row for a start failing alike when nothing was accepted ahead of it', async () => {
  const journal = await openAfterFailedStart('second')

  await fromInsideAWrite(journal, () => [reject(journal, 'second')])

  expect(journal.submission('second')?.dispatchState).toBe('rejected')
  expect(startRows(journal)).toEqual([rowKey('first')])
})

// The exit's batch also ends any turn its child ran: only the restated row is dropped.
it('drops only a restated row from a batch that carries other writes', async () => {
  const journal = await openAfterFailedStart()

  await journal.appendLifecycleBatch({
    settlementId: 'dead-generation:generation-2',
    fence: 0,
    recovered: true,
    mutations: [
      structuredAgentSessionStartFailureRow('generation-2', SIGNED_OUT),
      {
        kind: 'item',
        identity: NOTE,
        body: { kind: 'status', tone: 'info', text: 'settled' },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })

  expect(startRows(journal)).toEqual([rowKey('first')])
  expect(journal.itemBody(agentJournalItemKey(NOTE))).toMatchObject({ text: 'settled' })
})

it('writes nothing, and settles, for a batch whose only write restates its run', async () => {
  const journal = await openAfterFailedStart()
  const before = journal.cursor().sequence

  await expect(
    journal.appendLifecycleBatch({
      settlementId: 'dead-generation:generation-2',
      fence: 0,
      recovered: true,
      mutations: [structuredAgentSessionStartFailureRow('generation-2', SIGNED_OUT)]
    })
  ).resolves.toEqual({ epoch: 'epoch-1', sequence: before })

  expect(startRows(journal)).toEqual([rowKey('first')])
})
