// A person's Stop accepted in one transaction: it withdraws every queued send with exactly the rows
// the chat's queued withdrawal writes, then its Stop event, and nothing it has not handed over.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session-message-source'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from './journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-stop',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: claudeProviderHandle('native-1', null)
}
const WITHDRAWAL = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
  surface: 'rejection'
})

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-acceptance-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function text(value: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: value }] }
}

async function open(directory: string): Promise<AgentSessionJournal> {
  clock = 1_000
  return journals.open({
    identity: IDENTITY,
    stateDirectory: join(root, directory),
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
}

/** A person's send, accepted and queued. */
async function accept(journal: AgentSessionJournal, id: string): Promise<void> {
  const body = text(`text of ${id}`)
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: IDENTITY.sessionId,
      fields: { body }
    }),
    body,
    fence: 0,
    handoverRecorded: true,
    origin: 'client',
    source: USER_MESSAGE_SOURCE
  })
}

/** One send handed over, then two queued behind it. */
async function queuedBehindRunning(directory: string): Promise<AgentSessionJournal> {
  const journal = await open(directory)
  await accept(journal, 'running')
  await journal.resolveDispatch({
    clientMessageId: 'running',
    state: 'pending',
    fence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await accept(journal, 'first')
  await accept(journal, 'second')
  return journal
}

function rowsAfter(journal: AgentSessionJournal, sequence: number) {
  const since = journal.readSince({ epoch: journal.epoch, sequence })
  if (!since.ok) {
    throw new Error('expected the rows readable')
  }
  return since.rows
}

it("withdraws every queued send with the queued withdrawal's own rows, then writes its event", async () => {
  const withdrawn = await queuedBehindRunning('withdrawal')
  const before = withdrawn.cursor().sequence
  expect(await withdrawn.rejectQueuedSubmissions(0, WITHDRAWAL)).toEqual(['first', 'second'])
  const withdrawalRows = rowsAfter(withdrawn, before)

  const stopped = await queuedBehindRunning('stop')
  const accepted = await stopped.stops.accept({
    event: { reason: 'user-stop' },
    fence: 0,
    withdrawal: WITHDRAWAL
  })
  const stopRows = rowsAfter(stopped, before)

  expect(accepted.withdrawn).toEqual(['first', 'second'])
  // The same rows in kind, fact and words, all but where and when they landed.
  const shape = ({ seq: _seq, ts: _ts, ...row }: { seq: number; ts: number }) => row
  expect(stopRows.slice(0, -1).map(shape)).toEqual(withdrawalRows.map(shape))
  expect(stopRows.at(-1)).toMatchObject({ kind: 'tombstone', stopEvent: { reason: 'user-stop' } })
  expect(accepted.mark.sequence).toBe(stopRows.at(-1)?.seq)
  // One transaction stamps them alike; the withdrawal wrote each on its own.
  const settled = (journal: AgentSessionJournal, id: string) => ({
    ...journal.submission(id),
    resolvedAt: undefined
  })
  for (const id of ['first', 'second']) {
    expect(settled(stopped, id)).toEqual(settled(withdrawn, id))
  }
  // A send already handed over is not the queue's to withdraw.
  expect(stopped.submission('running')).toMatchObject({ dispatchState: 'pending' })
})

it('writes only its event with nothing queued', async () => {
  const journal = await open('empty')
  const before = journal.cursor().sequence

  const accepted = await journal.stops.accept({
    event: { reason: 'user-stop' },
    fence: 0,
    withdrawal: WITHDRAWAL
  })

  expect(accepted.withdrawn).toEqual([])
  expect(rowsAfter(journal, before)).toEqual([
    expect.objectContaining({ kind: 'tombstone', stopEvent: expect.anything() })
  ])
})
