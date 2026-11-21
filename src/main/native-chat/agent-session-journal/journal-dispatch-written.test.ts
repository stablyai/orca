import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/installation/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
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

const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'look at this' }]
}

async function openJournal(): Promise<SqlAgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'journal-dispatch-written-'))
  roots.push(root)
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  const journal = await SqlAgentSessionJournal.open({
    database: journalDatabase,
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    now: () => 100
  })
  journals.push(journal)
  return journal
}

describe('a send the agent took', () => {
  it('is stamped written only when handed to an idle agent and still pending', async () => {
    const journal = await openJournal()
    for (const clientMessageId of ['idle', 'steer', 'echoed']) {
      await journal.appendSubmission({
        clientMessageId,
        payloadFingerprint: `fingerprint:${clientMessageId}`,
        body,
        fence: 2,
        handoverRecorded: true,
        origin: 'client'
      })
    }
    await journal.prepareHandover({
      clientMessageId: 'idle',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    await journal.prepareHandover({
      clientMessageId: 'steer',
      fence: 2,
      turnScope: { kind: 'turn', turnItemId: 'orca:turn-running' },
      body
    })
    await journal.prepareHandover({
      clientMessageId: 'echoed',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    await journal.resolveDispatch({
      clientMessageId: 'echoed',
      fence: 2,
      state: 'accepted',
      providerIdentity: null
    })

    for (const clientMessageId of ['idle', 'steer', 'echoed']) {
      await journal.markDispatchWritten({ clientMessageId, fence: 2 })
    }

    expect(await journal.reads.submission('idle')).toMatchObject({
      dispatchState: 'pending',
      writtenAt: 100
    })
    expect((await journal.reads.submission('steer'))?.writtenAt).toBeUndefined()
    expect((await journal.reads.submission('echoed'))?.writtenAt).toBeUndefined()
  })

  // Forks copy turn records, not submissions; the turn must carry its own clock origin.
  it('keeps the stamp on the turn its send opens', async () => {
    const journal = await openJournal()
    await journal.appendSubmission({
      clientMessageId: 'idle',
      payloadFingerprint: 'fingerprint:idle',
      body,
      fence: 2,
      handoverRecorded: true,
      origin: 'client'
    })
    await journal.prepareHandover({
      clientMessageId: 'idle',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    await journal.markDispatchWritten({ clientMessageId: 'idle', fence: 2 })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'turn' },
      { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:idle', startedAt: 150 },
      { fence: 2, turnScope: { kind: 'thread' } }
    )
    expect((await journal.reads.item('orca:turn'))?.body).toMatchObject({
      kind: 'turn',
      writtenAt: 100
    })
  })
})
