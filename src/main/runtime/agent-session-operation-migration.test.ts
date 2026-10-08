import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from '../native-chat/agent-session-journal/journal-database-schema'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { AgentSessionOperationMaintenance } from './agent-session-operation-maintenance'
import {
  OPERATION_EXPIRY_SQL,
  OPERATION_ID_SQL,
  OPERATION_PANE_SQL,
  OPERATION_WORKTREE_SQL
} from './agent-session-operation-sql'

const NOW = 1_900_000_000_000
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-operation-migration-'))
})
afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function receipt(index: number, now = NOW) {
  return pendingAgentSessionOperationRow({
    callerKey: 'original-caller',
    operationId: `${now}-${index.toString(16).padStart(32, '0')}`,
    fingerprint: `fingerprint-${index}`,
    now
  })
}

function openStore() {
  return AgentSessionRecordStore.open({
    journalDatabase: openTestJournalHostDatabase(root),
    hostId: 'local'
  })
}

describe('receipt database compatibility', () => {
  it('indexes the current two-column database without rewriting rows and accepts older SQL writers', async () => {
    const row = {
      ...receipt(1),
      ownedPane: { worktreeId: 'folder', paneKey: 'tab:leaf' },
      futureMetadata: { retained: true },
      outcome: { status: 'succeeded', sessionId: 'chat-1' }
    }
    const key = agentSessionOperationKey(row.callerKey, row.operationId)
    const json = JSON.stringify(row, null, 2)
    const old = new Database(journalDatabasePath(root))
    old.exec(
      `${createJournalTablesSql()}${createAgentSessionRecordTablesSql()}PRAGMA user_version = 4`
    )
    old
      .prepare('INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)')
      .run(key, json)
    old.prepare('INSERT INTO agent_session_operations VALUES (?, ?)').run('malformed', '{')
    old.prepare('INSERT INTO agent_session_operations VALUES (?, ?)').run(
      'newer-shape',
      JSON.stringify({
        ...receipt(2),
        outcome: { status: 'future-status' }
      })
    )
    old.close()

    const store = openStore()
    expect(store.getOperationRow(row.callerKey, row.operationId)).toEqual(row)
    expect(
      await store.admitGlobalOperation({
        callerKey: 'reconnected',
        operationId: row.operationId,
        fingerprint: row.fingerprint,
        now: NOW + 12 * 60 * 60 * 1000
      })
    ).toMatchObject({
      decision: 'replay',
      row: { callerKey: row.callerKey, outcome: row.outcome }
    })
    expect(store.listOperationRowsOwningPane(row.ownedPane, NOW)).toHaveLength(1)
    const db = openTestJournalHostDatabase(root).db
    expect(
      db.prepare('SELECT row_json FROM agent_session_operations WHERE operation_key = ?').get(key)
        ?.row_json
    ).toBe(json)
    expect(
      db
        .prepare('SELECT row_json FROM agent_session_operations WHERE operation_key = ?')
        .get('malformed')?.row_json
    ).toBe('{')
    expect(store.findOperationRow(receipt(2).operationId)).toBeNull()
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    closeTestJournalHostDatabase(root)

    const downgraded = new Database(journalDatabasePath(root))
    const extra = receipt(3)
    const extraKey = agentSessionOperationKey(extra.callerKey, extra.operationId)
    downgraded
      .prepare(`INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)
      ON CONFLICT(operation_key) DO UPDATE SET row_json = excluded.row_json`)
      .run(extraKey, JSON.stringify(extra))
    downgraded.close()
    expect(openStore().getOperationRow(extra.callerKey, extra.operationId)).toEqual(extra)
  })

  it('uses indexes for global lookup, expiry maintenance and owned-pane reads', () => {
    const db = openTestJournalHostDatabase(root).db
    const queries = [
      {
        sql: `SELECT row_json FROM agent_session_operations WHERE ${OPERATION_ID_SQL} = ? ORDER BY rowid`,
        args: ['id'],
        index: 'agent_session_operations_id'
      },
      {
        sql: `SELECT row_json FROM agent_session_operations WHERE ${OPERATION_EXPIRY_SQL} <= ? ORDER BY ${OPERATION_EXPIRY_SQL}, rowid LIMIT 256`,
        args: [NOW],
        index: 'agent_session_operations_expiry'
      },
      {
        sql: `SELECT row_json FROM agent_session_operations WHERE ${OPERATION_WORKTREE_SQL} = ? AND ${OPERATION_PANE_SQL} = ? AND ${OPERATION_EXPIRY_SQL} > ?`,
        args: ['folder', 'tab:leaf', NOW],
        index: 'agent_session_operations_pane'
      }
    ]
    for (const { sql, args, index } of queries) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
      expect(plan.some((step) => String(step.detail).includes(`USING INDEX ${index}`))).toBe(true)
    }
  })

  it('bounds deletion and passes unreadable expired rows without deleting them or starving others', () => {
    const host = openTestJournalHostDatabase(root)
    const expiredAt = NOW - 100_000_000
    host.transaction((db) => {
      const insert = db.prepare('INSERT INTO agent_session_operations VALUES (?, ?)')
      for (let index = 0; index < 300; index += 1) {
        insert.run(
          `future-${index}`,
          JSON.stringify({ ...receipt(index, expiredAt), outcome: { status: 'future-status' } })
        )
      }
      for (let index = 300; index < 600; index += 1) {
        const row = receipt(index, expiredAt)
        insert.run(agentSessionOperationKey(row.callerKey, row.operationId), JSON.stringify(row))
      }
    })
    const count = () =>
      Number(host.db.prepare('SELECT count(*) AS n FROM agent_session_operations').get()?.n)
    const maintenance = new AgentSessionOperationMaintenance(host)
    maintenance.run(NOW)
    expect(count()).toBe(600)
    maintenance.run(NOW)
    expect(count()).toBe(388)
    maintenance.run(NOW)
    expect(count()).toBe(300)
    expect(
      host.db
        .prepare('SELECT row_json FROM agent_session_operations WHERE operation_key = ?')
        .get('future-0')
    ).toBeDefined()
  })
})
