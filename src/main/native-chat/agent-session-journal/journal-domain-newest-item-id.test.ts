import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainEntity } from './journal-domain-entity-read'
import { JournalSqlScope } from './journal-sql-scope'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../shared/agent-session/journal/agent-session-turn-notice'

// The newest saved permission row is the one appended last, even when a clock moved back gave it a
// lower id; and the read seeks into that row family's primary-key range rather than walking the
// chat's whole visible-position index.

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const target = { sessionId: 'chat', epoch: 'epoch' }
const PREFIX = 'full-access-refused:claude:'
const key = (clientMessageId: string) => agentJournalItemKey({ provider: 'orca', clientMessageId })

it('returns the row appended last and reads it through the primary-key range', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-newest-item-id-'))
  directories.push(directory)
  const db = new Database(join(directory, 'journal.sqlite'))
  migrateJournalDomainSchema(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`).run()
  const append = (clientMessageId: string, text: string) =>
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId },
        body: {
          kind: 'status',
          tone: 'warning',
          presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
          text
        },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      1_800_000_000_000
    )
  const recovery = `${PREFIX}t0000000009:earlier:1:restored:bypassPermissions`
  // Minted after the clock moved back: a lower id, appended later.
  const warning = `${PREFIX}t0000000005:later:1:running:unconfirmed`
  append(recovery, 'Claude uses Full access again.')
  for (let index = 0; index < 50; index += 1) {
    append(`note-${index}`, 'unrelated row')
  }
  append(warning, "Full access is off, and Claude hasn't confirmed which approval mode it uses.")

  const statements: string[] = []
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    statements.push(sql)
    return prepare(sql)
  })
  const prefix = key(PREFIX)
  const result = readJournalDomainEntity(new JournalSqlScope(db, 'chat', 'epoch'), {
    kind: 'newest-item-id',
    prefix,
    timedFrom: 't'
  })
  expect(result).toEqual({
    kind: 'newest-item-id',
    itemId: key(warning),
    greatestTimedId: key(recovery)
  })

  const byPosition = statements.filter((sql) => sql.includes('ORDER BY sequence DESC'))
  expect(byPosition).toHaveLength(1)
  vi.restoreAllMocks()
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${byPosition[0]}`)
    .all('chat', 'epoch', prefix, `${prefix}\uffff`)
    .map((row) => String(row.detail))
  expect(
    plan.some((detail) =>
      detail.startsWith('SEARCH journal_items USING INDEX sqlite_autoindex_journal_items_1 ')
    )
  ).toBe(true)
  expect(plan.join('\n')).not.toContain('journal_items_visible_position')
})
