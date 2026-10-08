import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { AgentSessionOperationMaintenance } from './agent-session-operation-maintenance'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../shared/agent-session-host-authority'

const NOW = 1_900_000_000_000
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-operation-repository-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function operation(index: number, now = NOW) {
  return {
    callerKey: 'background',
    operationId: `${now}-${index.toString(16).padStart(32, '0')}`,
    fingerprint: `fingerprint-${index}`,
    now
  }
}

function openStore() {
  return AgentSessionRecordStore.open({
    journalDatabase: openTestJournalHostDatabase(root),
    hostId: 'local'
  })
}

describe('disk-backed operation receipts', () => {
  it('opens 50k retained receipts and admits a fresh write without loading the ledger', async () => {
    const host = openTestJournalHostDatabase(root)
    host.transaction((db) => {
      const insert = db.prepare(
        'INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)'
      )
      for (let index = 0; index < 50_000; index += 1) {
        const row = pendingAgentSessionOperationRow(operation(index))
        insert.run(agentSessionOperationKey(row.callerKey, row.operationId), JSON.stringify(row))
      }
    })
    const prepare = vi.spyOn(host.db, 'prepare')
    const store = openStore()
    const fresh = { ...operation(50_000), callerKey: 'desktop-renderer' }
    expect(await store.admitGlobalOperation(fresh)).toMatchObject({ decision: 'admit' })
    expect(await store.admitGlobalOperation(operation(0))).toMatchObject({ decision: 'replay' })
    const receiptReads = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /SELECT[\s\S]+FROM agent_session_operations/i.test(sql))
    expect(receiptReads.length).toBeGreaterThan(0)
    expect(receiptReads.every((sql) => /WHERE/i.test(sql))).toBe(true)
    expect(host.db.prepare('SELECT count(*) AS n FROM agent_session_operations').get()?.n).toBe(
      50_001
    )
  })

  it('does not delete unrelated expired receipts inside a fresh admission', async () => {
    const host = openTestJournalHostDatabase(root)
    host.transaction((db) => {
      const expired = pendingAgentSessionOperationRow(operation(1, NOW - 100_000_000))
      db.prepare('INSERT INTO agent_session_operations VALUES (?, ?)').run(
        agentSessionOperationKey(expired.callerKey, expired.operationId),
        JSON.stringify(expired)
      )
      db.exec(`CREATE TRIGGER refuse_receipt_cleanup BEFORE DELETE ON agent_session_operations
        BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    })
    const store = openStore()
    await expect(store.admitGlobalOperation(operation(2))).resolves.toMatchObject({
      decision: 'admit'
    })
    expect(host.db.prepare('SELECT count(*) AS n FROM agent_session_operations').get()?.n).toBe(2)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new AgentSessionOperationMaintenance(host).run(NOW)
    expect(warn).toHaveBeenCalledWith(
      '[agent-session-journal] expired operation receipt cleanup failed',
      expect.any(Error)
    )
    await expect(store.admitGlobalOperation(operation(3))).resolves.toMatchObject({
      decision: 'admit'
    })
    host.db.exec('DROP TRIGGER refuse_receipt_cleanup')
    new AgentSessionOperationMaintenance(host).run(NOW)
    expect(host.db.prepare('SELECT count(*) AS n FROM agent_session_operations').get()?.n).toBe(2)
  })

  it('warns once per failing streak of receipt cleanup, and once when it recovers', () => {
    const host = openTestJournalHostDatabase(root)
    const refuseCleanup = () =>
      host.db.exec(`CREATE TRIGGER refuse_receipt_cleanup BEFORE DELETE ON agent_session_operations
        BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    const insertExpired = (index: number) =>
      host.transaction((db) => {
        const expired = pendingAgentSessionOperationRow(operation(index, NOW - 100_000_000))
        db.prepare('INSERT INTO agent_session_operations VALUES (?, ?)').run(
          agentSessionOperationKey(expired.callerKey, expired.operationId),
          JSON.stringify(expired)
        )
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const maintenance = new AgentSessionOperationMaintenance(host)

    refuseCleanup()
    insertExpired(1)
    maintenance.run(NOW)
    maintenance.run(NOW)
    maintenance.run(NOW)
    expect(warn).toHaveBeenCalledTimes(1)

    host.db.exec('DROP TRIGGER refuse_receipt_cleanup')
    maintenance.run(NOW)
    maintenance.run(NOW)
    expect(info).toHaveBeenCalledTimes(1)
    expect(host.db.prepare('SELECT count(*) AS n FROM agent_session_operations').get()?.n).toBe(0)

    // A new streak warns again.
    refuseCleanup()
    insertExpired(2)
    maintenance.run(NOW)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('serializes global identities, preserves the original caller, and permits caller-scoped collisions', async () => {
    const store = openStore()
    const first = operation(10)
    const second = { ...first, callerKey: 'reconnected' }
    const results = await Promise.all([
      store.admitGlobalOperation(first),
      store.admitGlobalOperation(second)
    ])
    expect(results.map((result) => result.decision)).toEqual(['admit', 'replay'])
    expect(results[1]).toMatchObject({ row: { callerKey: first.callerKey } })
    expect(store.getOperationRow(second.callerKey, first.operationId)).toBeNull()
    await store.recordOperationOutcome({
      callerKey: first.callerKey,
      operationId: first.operationId,
      outcome: { status: 'succeeded', sessionId: 'original-chat' }
    })
    expect(await store.admitGlobalOperation(second)).toMatchObject({
      decision: 'replay',
      row: { outcome: { sessionId: 'original-chat' } }
    })
    expect(
      await store.admitGlobalOperation({ ...second, fingerprint: 'other-chat-or-payload' })
    ).toMatchObject({
      decision: 'refused',
      code: 'agent_session_operation_conflict'
    })
    expect(await store.admitOperation({ ...second, fingerprint: 'caller-scoped' })).toMatchObject({
      decision: 'admit'
    })
    await store.recordOperationOutcome({
      operationId: first.operationId,
      outcome: { status: 'unknown' }
    })
    expect(store.getOperationRow(first.callerKey, first.operationId)?.outcome.status).toBe(
      'succeeded'
    )
    expect(store.getOperationRow(second.callerKey, first.operationId)?.outcome.status).toBe(
      'unknown'
    )
  })

  it('rolls admission and its conditional claim back together and grants one claimant', async () => {
    const host = openTestJournalHostDatabase(root)
    const store = openStore()
    const args = {
      ...operation(20),
      ownedPane: { worktreeId: 'folder-workspace', paneKey: 'tab:leaf' },
      terminalCreate: { executionHostId: 'ssh:host-a', terminalHandle: 'stable-handle' }
    }
    host.db.exec(`CREATE TRIGGER refuse_claim BEFORE UPDATE ON agent_session_operations
      BEGIN SELECT RAISE(ABORT, 'claim unavailable'); END`)
    await expect(store.admitAndClaimOperation(args, () => true)).rejects.toThrow(
      'claim unavailable'
    )
    expect(store.getOperationRow(args.callerKey, args.operationId)).toBeNull()
    host.db.exec('DROP TRIGGER refuse_claim')
    const results = await Promise.all([
      store.admitAndClaimOperation(args, () => true),
      store.admitAndClaimOperation(args, () => true)
    ])
    expect(results.map((result) => result.claim?.claim)).toEqual(['won', 'lost'])
    expect(openStore().getOperationRow(args.callerKey, args.operationId)).toMatchObject({
      outcome: { status: 'unknown' },
      ownedPane: args.ownedPane,
      terminalCreate: args.terminalCreate
    })
    expect(store.listOperationRowsOwningPane(args.ownedPane, NOW)).toHaveLength(1)
    expect(
      store.listOperationRowsOwningPane({ ...args.ownedPane, worktreeId: 'other-host' }, NOW)
    ).toEqual([])
    expect(store.listOperationRowsOwningPane(args.ownedPane, NOW + 100_000_000)).toEqual([])
  })

  it('retains accepted future skew through expiry and never admits the aged id again', async () => {
    const store = openStore()
    const args = operation(30, NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS)
    const admitted = await store.admitOperation({ ...args, now: NOW })
    expect(admitted.decision).toBe('admit')
    if (admitted.decision !== 'admit') {
      throw new Error('expected admission')
    }
    const expiry = admitted.row.expiresAt
    expect(expiry).toBe(
      args.now + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
    )
    expect(await store.admitOperation({ ...args, now: expiry - 1 })).toMatchObject({
      decision: 'replay'
    })
    expect(await store.admitOperation({ ...args, now: expiry })).toMatchObject({
      decision: 'refused',
      code: 'agent_session_operation_expired'
    })
    new AgentSessionOperationMaintenance(openTestJournalHostDatabase(root)).run(expiry)
    expect(await store.admitOperation({ ...args, now: expiry })).toMatchObject({
      decision: 'refused',
      code: 'agent_session_operation_expired'
    })
    expect(
      await store.admitOperation(operation(31, NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1))
    ).toMatchObject({ decision: 'admit' })
    expect(
      await store.admitOperation({
        ...operation(32, NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1),
        now: NOW
      })
    ).toMatchObject({
      decision: 'refused',
      code: 'agent_session_operation_invalid'
    })
  })
})
