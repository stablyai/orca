import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'

export const lifecycleTarget = { sessionId: 'chat', epoch: 'epoch', ownerToken: 'owner' }
export const lifecycleOptions = { fence: 1, turnScope: { kind: 'thread' as const } }
export const lifecycleFacts: JournalWriterHostFacts = {
  identity: {
    sessionId: 'chat',
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread')
  }
}
export const lifecycleIdentity = (clientMessageId: string) => ({
  provider: 'orca' as const,
  clientMessageId
})

export function domainLifecycleFixture(cleanups: (() => void)[], sessionId = 'chat') {
  const target = { ...lifecycleTarget, sessionId }
  const defaultFacts = { ...lifecycleFacts, identity: { ...lifecycleFacts.identity, sessionId } }
  const directory = mkdtempSync(join(tmpdir(), 'orca-domain-lifecycle-'))
  const filename = join(directory, 'journal.sqlite')
  let db = new Database(filename)
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(session_id,workspace_id,epoch,highest_fence) VALUES(?,'workspace','epoch',1)`
  ).run(sessionId)
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    get db() {
      return db
    },
    reopen() {
      db.close()
      db = new Database(filename)
    },
    item(key: string): AgentJournalRenderItem | undefined {
      const row = db.prepare(`SELECT payload_json FROM journal_items WHERE item_id=?`).get(key)
      return row ? JSON.parse(String(row.payload_json)) : undefined
    },
    async run(
      operation: JournalWriterOperation,
      facts: JournalWriterHostFacts = defaultFacts,
      effects?: JournalWriterCommand['effects']
    ) {
      const command = { target, operation, facts, ...(effects ? { effects } : {}) }
      const answer = (
        await new JournalSqlBatch(db).run([command], (command) =>
          new JournalSqlCommand(db, directory).apply(command, 100)
        )
      ).outcomes[0]!
      if (!answer.committed) {
        throw answer.error
      }
      return answer.value
    }
  }
}
