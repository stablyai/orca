import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/installation/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import { closeTestJournalHostDatabases } from './store-lifecycle/journal-host-database-test-support'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'
import { withTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'

export function storedProviderReceipt(
  stateDirectory: string,
  sessionId: string,
  clientMessageId: string
): Promise<unknown> {
  return withTestAgentSessionDatabase(
    stateDirectory,
    (db) =>
      db
        .prepare(`SELECT json_extract(facts_json, '$.writtenAt') AS writtenAt
      FROM journal_submission_attempts WHERE session_id=? AND message_id=? AND current=1`)
        .get(sessionId, clientMessageId)?.writtenAt ?? undefined
  )
}

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
export function receipt(clientMessageId: string) {
  return storedProviderReceipt(roots.at(-1)!, 'session', clientMessageId)
}

const journals: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export async function openJournal(now = 100): Promise<SqlAgentSessionJournal> {
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
    now: () => now
  })
  journals.push(journal)
  return journal
}
