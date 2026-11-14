import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentJournalProducerLinkage } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { AgentSessionJournal } from './journal-store'
import { SqlAgentSessionJournal } from './journal-sql-store'
import { closeTestJournalHostDatabase } from './store-lifecycle/journal-host-database-test-support'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
  for (const root of roots.splice(0)) {
    await closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

const identity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

type Journal = Pick<AgentSessionJournal, 'appendItem' | 'settleUnheldTurns'> & {
  turnState: (turnId: string) => Promise<unknown>
}

async function sql(root: string): Promise<Journal> {
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  const journal = await SqlAgentSessionJournal.open({
    database: journalDatabase,
    identity,
    now: () => 100
  })
  return Object.assign(journal, {
    turnState: async (turnId: string) => (await journal.reads.item(`orca:${turnId}`))?.body
  })
}

it('selects unheld running turns after earlier queued writes on the SQL writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-unheld-turns-'))
  roots.push(root)
  const journal = await sql(root)
  const turn = (
    turnId: string,
    state: 'running' | 'completed',
    fence: number,
    producer: AgentJournalProducerLinkage = {}
  ) =>
    journal.appendItem(
      { provider: 'orca', clientMessageId: turnId },
      { kind: 'turn', turnId, state, ...(state === 'completed' ? { completedAt: 90 } : {}) },
      { fence, turnScope: { kind: 'thread' }, ...producer }
    )
  await turn('older-child', 'running', 1)
  await turn('finished', 'running', 2)

  // Queued, not awaited: the settlement must see these at its write position.
  const queued = [
    turn('restored', 'running', 2),
    turn('live', 'running', 2),
    turn('subagent', 'running', 2, { agentId: 'helper' }),
    turn('finished', 'completed', 2)
  ]
  const settled = journal.settleUnheldTurns({
    sessionId: 'session',
    fence: 2,
    generation: 'g1',
    liveTurnId: 'live'
  })
  await Promise.all([...queued, settled])

  expect(await journal.turnState('restored')).toMatchObject({ state: 'interrupted' })
  expect(await journal.turnState('finished')).toMatchObject({
    state: 'completed',
    completedAt: 90
  })
  for (const turnId of ['live', 'subagent', 'older-child']) {
    expect(await journal.turnState(turnId)).toMatchObject({ state: 'running' })
  }

  // One settlement per child generation, even when a later turn runs unheld.
  await turn('later', 'running', 2)
  await journal.settleUnheldTurns({
    sessionId: 'session',
    fence: 2,
    generation: 'g1',
    liveTurnId: null
  })
  expect(await journal.turnState('later')).toMatchObject({ state: 'running' })
})
