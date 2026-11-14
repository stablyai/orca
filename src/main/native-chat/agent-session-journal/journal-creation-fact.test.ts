import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { AgentSessionJournal } from './journal-store'
import { SqlAgentSessionJournal } from './journal-sql-store'
import { closeTestJournalHostDatabase } from './store-lifecycle/journal-host-database-test-support'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'
import type { JournalStepsResult, JournalWriterStep } from './writing/journal-writer-step'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    })
  )
})

const identity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

type CreationJournal = Pick<AgentSessionJournal, 'reads' | 'appendTombstone'> & {
  appendSteps(
    steps: readonly JournalWriterStep[],
    beforeRun?: () => boolean
  ): Promise<JournalStepsResult>
}

async function sql(root: string): Promise<CreationJournal> {
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  return SqlAgentSessionJournal.open({ database: journalDatabase, identity, now: () => 100 })
}

it('records creation once at its destination on the SQL writer, including removed cards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-creation-fact-'))
  roots.push(root)
  const journal = await sql(root)
  const step: Extract<JournalWriterStep, { kind: 'creation-fact' }> = {
    kind: 'creation-fact',
    epoch: (await journal.reads.physicalCursor()).epoch,
    identity: { provider: 'orca', clientMessageId: 'agent-start:dispatch' },
    body: {
      kind: 'agent-start',
      dispatchId: 'dispatch',
      worker: {
        party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
        name: null
      },
      task: 'Build it'
    },
    options: { fence: 1, turnScope: { kind: 'thread' }, observedAt: 100 },
    reservedBytes: 4096
  }
  expect(
    await journal.appendSteps([step, { ...step, body: { ...step.body, task: 'Retry' } }])
  ).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }]
  })
  expect(await journal.reads.item('orca:agent-start%3Adispatch')).toMatchObject({
    revision: 1,
    body: { task: 'Build it' }
  })
  const removed = journal.appendTombstone(step.identity, { fence: 1 })
  const replayed = journal.appendSteps([step])
  await removed
  expect(await replayed).toMatchObject({ outcomes: [{ kind: 'dropped' }] })
  expect(await journal.reads.item('orca:agent-start%3Adispatch')).toBeNull()
  const other = {
    ...step,
    identity: { provider: 'orca' as const, clientMessageId: 'agent-start:other' }
  }
  expect(await journal.appendSteps([{ ...other, epoch: 'retired-epoch' }])).toMatchObject({
    outcomes: [{ kind: 'dropped' }]
  })
  expect(await journal.appendSteps([other], () => false)).toMatchObject({
    outcomes: [{ kind: 'dropped' }]
  })
  expect(await journal.reads.item('orca:agent-start%3Aother')).toBeNull()
})
