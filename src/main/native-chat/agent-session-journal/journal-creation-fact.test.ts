import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/installation/structured-agent-session-journal-open'
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

it('proves only a native saved receipt revision, never an ordinary copied body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-native-receipt-'))
  roots.push(root)
  let journal = await sql(root)
  const body = {
    kind: 'automation-saved' as const,
    change: 'created' as const,
    automation: {
      id: 'a',
      name: 'Saved',
      enabled: true,
      nextRunAt: 0,
      updatedAt: 3,
      dtstart: 0,
      rrule: '0 * * * *',
      workspaceId: null
    }
  }
  const step = {
    kind: 'creation-fact' as const,
    epoch: (await journal.reads.physicalCursor()).epoch,
    identity: { provider: 'orca' as const, clientMessageId: 'saved:a' },
    body,
    options: { fence: 1, turnScope: { kind: 'thread' as const } },
    reservedBytes: 4096
  }
  await journal.appendSteps([step])
  expect(await journal.reads.nativeAutomationReceipt('orca:saved%3Aa')).toMatchObject({
    revision: 1,
    body: { kind: 'automation-saved', automation: { id: 'a' } }
  })
  await databases.pop()!.close()
  await closeTestJournalHostDatabase(root)
  journal = await sql(root)
  expect(await journal.reads.nativeAutomationReceipt('orca:saved%3Aa')).toMatchObject({
    revision: 1,
    body: { automation: { id: 'a' } }
  })
  await journal.appendSteps([
    { ...step, kind: 'item', identity: { provider: 'orca', clientMessageId: 'copied:a' } }
  ])
  expect(await journal.reads.nativeAutomationReceipt('orca:copied%3Aa')).toBeNull()
  await journal.appendSteps([{ ...step, kind: 'item', body: { ...body, change: 'updated' } }])
  expect(await journal.reads.nativeAutomationReceipt('orca:saved%3Aa')).toBeNull()
})
