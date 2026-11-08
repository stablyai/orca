import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from '../agent-session-wire/publication/history/testing/agent-session-history-contract-test-fixture'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openTestJournalHostDatabase } from './store-lifecycle/journal-host-database-test-support'
import { convertJournalSqlProjection } from './journal-sql-conversion'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'
import { journalSqlReads } from './journal-sql-reads'
import type { AgentSessionJournalReads } from './journal-reads'

const thread = { kind: 'thread' as const }
const orca = (clientMessageId: string) => ({ provider: 'orca' as const, clientMessageId })
const user = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const signedOut = {
  kind: 'status' as const,
  ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'row' })
}

async function send(clientMessageId: string, text: string): Promise<void> {
  const { journal } = fixture
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: clientMessageId,
    body: user(text),
    fence: 1,
    handoverRecorded: true
  })
  await journal.resolveDispatch({
    clientMessageId,
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
}

it('answers lifecycle reads from one database snapshot exactly as the in-memory chat does', async () => {
  const { journal } = fixture
  await send('first', 'first prompt')
  const offered = await journal.reads.cursor()
  await send('second', 'second prompt')
  // Neither a command, a subagent's prompt nor a removed row is the chat's latest prompt.
  await journal.appendItem(
    orca('command'),
    { ...user('/compact'), command: { name: 'compact' } },
    { fence: 1, turnScope: thread }
  )
  await journal.appendItem(orca('child-prompt'), user('child prompt'), {
    fence: 1,
    turnScope: thread,
    agentId: 'child-agent',
    producerKind: 'agent'
  })
  await journal.appendItem(orca('removed'), user('removed prompt'), { fence: 1, turnScope: thread })
  await journal.appendTombstone(orca('removed'), { fence: 1 })
  await journal.appendItem(
    orca('turn-1'),
    { kind: 'turn', turnId: 'turn-1', state: 'completed', startedAt: 10, completedAt: 20 },
    { fence: 1, turnScope: thread }
  )
  // Sign-out at fence 2 is the root's; at fence 3 only a subagent reported it.
  await journal.appendItem(orca('root-signed-out'), signedOut, { fence: 2, turnScope: thread })
  await journal.appendItem(orca('child-signed-out'), signedOut, {
    fence: 3,
    turnScope: thread,
    agentId: 'child-agent',
    producerKind: 'agent'
  })

  const answers = (reads: AgentSessionJournalReads) =>
    Promise.all([
      reads.latestPrompt(),
      reads.restartProgress(offered),
      reads.outgrownChild({ fence: 2, nextClientMessageId: 'second' }),
      reads.outgrownChild({ fence: 3, nextClientMessageId: 'turn-1' }),
      reads.outgrownChild({ fence: 1, nextClientMessageId: 'missing' }),
      reads.outgrownChild({ fence: 4 })
    ])
  const memory = await answers(journal.reads)
  const [prompt, progress, rootFence, childFence, oldFence, unknownFence] = memory
  expect(prompt).toBe('second prompt')
  expect(progress.epoch).toBe(offered.epoch)
  expect(progress.acceptedInputs.map((input) => input.clientMessageId)).toEqual(['second'])
  expect(rootFence).toEqual({
    signedOut: true,
    newestTurnCompletedAt: 20,
    nextMessage: user('second prompt')
  })
  expect(childFence).toEqual({ signedOut: false, newestTurnCompletedAt: 20, nextMessage: null })
  expect(oldFence.signedOut).toBe(false)
  expect(unknownFence).toEqual({ signedOut: false, newestTurnCompletedAt: 20, nextMessage: null })

  const database = openTestJournalHostDatabase(fixture.root)
  database.transaction((db) => convertJournalSqlProjection(db, 'session-1'))
  const pool = new JournalSqlReaderPool(
    join(fixture.root, 'agent-session-journal.db'),
    journalSqlReaderPath()
  )
  try {
    expect(await answers(journalSqlReads(pool, 'session-1'))).toEqual(memory)
  } finally {
    await pool.close()
  }
})
