import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { recordStructuredAgentSessionStartFailure } from '../agent-session-wire/startup/structured-agent-session-start-failure-row'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { AgentSessionJournal } from './journal-store'
import { SqlAgentSessionJournal } from './journal-sql-store'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { closeTestJournalHostDatabases } from './store-lifecycle/journal-host-database-test-support'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
const journals: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const identity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}
const words = agentSessionFailureWords(agentSessionFailureFact('hostStopped'), {
  surface: 'rejection'
})
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'continue with this work' }]
}

type Journal = Pick<
  AgentSessionJournal,
  'appendSubmission' | 'prepareHandover' | 'settleStartFailure' | 'reads'
> & {
  resolveDispatch(input: Parameters<AgentSessionJournal['resolveDispatch']>[0]): Promise<unknown>
  queued<T>(run: () => T): Promise<T>
  cards(): Promise<readonly QueuedMessageRow[]>
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
  journals.push(journal)
  return Object.assign(journal, {
    queued: <T>(run: () => T) => journal.readInOrder(run),
    cards: () => journal.queuedMessages.list()
  })
}

describe('failed-start settlement on the SQL writer', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'journal-start-failure-'))
    roots.push(root)
    const journal = await sql(root)
    return {
      journal,
      submit: (clientMessageId: string) =>
        journal.appendSubmission({
          clientMessageId,
          payloadFingerprint: `fingerprint:${clientMessageId}`,
          body,
          fence: 2,
          handoverRecorded: true,
          origin: 'client',
          options: { model: 'picked' }
        }),
      fail: (clientMessageId: string | null, startKey: string | null = 'start') =>
        recordStructuredAgentSessionStartFailure(
          { journal, fence: 2 },
          { ...words, startKey },
          clientMessageId
        )
    }
  }

  it('retains only the requested queued send after preceding writes and settles once', async () => {
    const { journal, submit, fail } = await fixture()
    await submit('other')
    // Return promises without awaiting inside the read, so both writes join the busy lane.
    await Promise.all(await journal.queued(() => [submit('requested'), fail('requested', null)]))
    expect(await journal.reads.submission('requested')).toMatchObject({
      dispatchState: 'rejected',
      keptAsQueuedMessageId: 'requested',
      recovered: true
    })
    expect(await journal.reads.submission('other')).toMatchObject({ dispatchState: 'pending' })
    expect(await journal.cards()).toMatchObject([
      {
        messageId: 'requested',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'continue with this work' }]
        },
        options: { model: 'picked' },
        returnedRejection: { kind: 'hostStopped' }
      }
    ])
    expect(await journal.reads.item('orca:start-failure%3Arequested')).toMatchObject({
      body: { kind: 'status', failure: { kind: 'hostStopped' } }
    })

    const before = await journal.reads.cursor()
    await fail('other', 'requested')
    expect(await journal.reads.cursor()).toEqual(before)
    expect(await journal.reads.submission('other')).toMatchObject({ dispatchState: 'pending' })
  })

  it('leaves sends alone when preceding writes have handed them over or delivered them', async () => {
    const { journal, submit, fail } = await fixture()
    await submit('handed-over')
    await submit('delivered')
    await Promise.all(
      await journal.queued(() => [
        journal.prepareHandover({
          clientMessageId: 'handed-over',
          fence: 2,
          turnScope: { kind: 'thread' },
          body
        }),
        fail('handed-over', 'handover-start'),
        journal.resolveDispatch({
          clientMessageId: 'delivered',
          fence: 2,
          state: 'accepted',
          providerIdentity: null
        }),
        fail('delivered', 'delivered-start')
      ])
    )
    expect(await journal.reads.submission('handed-over')).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })
    expect(await journal.reads.submission('delivered')).toMatchObject({ dispatchState: 'accepted' })
    expect(await journal.reads.item('orca:start-failure%3Ahandover-start')).toBeNull()
    expect(await journal.reads.item('orca:start-failure%3Adelivered-start')).toBeNull()
    expect(await journal.cards()).toEqual([])
  })

  it('does not mark an ineligible attempt settled and preserves row-only failures', async () => {
    const { journal, submit, fail } = await fixture()
    const before = await journal.reads.cursor()
    await fail('later')
    expect(await journal.reads.cursor()).toEqual(before)
    await submit('later')
    await fail('later')
    expect(await journal.reads.submission('later')).toMatchObject({ dispatchState: 'rejected' })
    expect(await journal.reads.item('orca:start-failure%3Astart')).toMatchObject({
      body: { kind: 'status', failure: { kind: 'hostStopped' } }
    })

    await fail(null, 'row-only')
    expect(await journal.reads.item('orca:start-failure%3Arow-only')).toMatchObject({
      body: { kind: 'status', failure: { kind: 'hostStopped' } }
    })
    const after = await journal.reads.cursor()
    await fail(null, 'row-only')
    await fail(null, null)
    expect(await journal.reads.cursor()).toEqual(after)
  })
})
