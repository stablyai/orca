import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { CONTROL_RENEWAL_BATCH_SQL } from './control-renewal-statement.js'
import type { ControlRenewalOutcome } from './control-renewal-statement.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type SqlRow
} from './database.js'

const now = 1_900_000_000_000
const expiresAt = now + 105_000

function renewal(userId: string, relayHostId: string, expiry = expiresAt) {
  return {
    identity: { userId, relayHostId },
    activityId: 'control:cell-a:1',
    cellId: 'cell-a',
    expiresAt: expiry
  }
}

// A PostgreSQL-dialect database that answers the renewal statement without a
// server, so the statement count and its parameter arrays are observable.
class RenewalStatementProbe implements RelayDatabase {
  readonly dialect = 'postgres' as const
  readonly statements: Array<{ sql: string; params: unknown[] }> = []
  failuresRemaining = 0

  constructor(private readonly outcomeFor: (userId: string) => ControlRenewalOutcome) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    this.statements.push({ sql, params })
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('canceling statement due to statement timeout')
    }
    const userIds = params[0] as string[]
    return userIds.map((userId, index) => ({
      row_index: String(index + 1),
      outcome: this.outcomeFor(userId)
    }))
  }

  async queryLocked(): Promise<SqlRow[]> {
    throw new Error('unexpected_locked_query')
  }

  async transaction<T>(): Promise<T> {
    // Renewals must never open one: that is the write transaction per host this
    // batch exists to remove.
    throw new Error('unexpected_transaction')
  }

  async close(): Promise<void> {}
}

describe('batched control renewals on PostgreSQL', () => {
  it('spends one statement on every host that came due', async () => {
    const probe = new RenewalStatementProbe(() => 'renewed')
    const store = new RelayAssignmentStore(probe, () => now)

    const outcomes = await store.renewControlActivities([
      renewal('user-a', 'host000000000001'),
      renewal('user-a', 'host000000000002'),
      renewal('user-b', 'host000000000003')
    ])

    expect(outcomes).toEqual(['renewed', 'renewed', 'renewed'])
    expect(probe.statements).toHaveLength(1)
    expect(probe.statements[0]!.sql).toBe(CONTROL_RENEWAL_BATCH_SQL)
    expect(probe.statements[0]!.params[0]).toEqual(['user-a', 'user-a', 'user-b'])
    expect(probe.statements[0]!.params[4]).toEqual([expiresAt, expiresAt, expiresAt])
  })

  it('locks assignment rows in primary-key order and still answers in input order', async () => {
    const probe = new RenewalStatementProbe((userId) =>
      userId === 'user-b' ? 'control_activity_moved' : 'renewed'
    )
    const store = new RelayAssignmentStore(probe, () => now)

    const outcomes = await store.renewControlActivities([
      renewal('user-c', 'host000000000003'),
      renewal('user-a', 'host000000000002'),
      renewal('user-b', 'host000000000001'),
      renewal('user-a', 'host000000000001')
    ])

    // (user_id, relay_host_id) is the primary key of relay_assignments, and the
    // statement's ORDER BY repeats it: no batch can queue against another in a
    // different sequence.
    expect(probe.statements[0]!.params[0]).toEqual(['user-a', 'user-a', 'user-b', 'user-c'])
    expect(probe.statements[0]!.params[1]).toEqual([
      'host000000000001',
      'host000000000002',
      'host000000000001',
      'host000000000003'
    ])
    expect(outcomes).toEqual([
      'renewed',
      'renewed',
      'control_activity_moved',
      'renewed'
    ])
  })

  it('keeps a malformed request out of the statement and fails only that row', async () => {
    const probe = new RenewalStatementProbe(() => 'renewed')
    const store = new RelayAssignmentStore(probe, () => now)

    const outcomes = await store.renewControlActivities([
      renewal('user-a', 'host000000000001'),
      renewal('user-a', 'host000000000002', now + ASSIGNMENT_LIMITS.activityLeaseMs * 10),
      { ...renewal('user-a', 'host000000000003'), activityId: '' },
      renewal('user-a', 'host000000000004')
    ])

    expect(outcomes).toEqual([
      'renewed',
      'invalid_activity_expiry',
      'invalid_activity_id',
      'renewed'
    ])
    expect(probe.statements[0]!.params[1]).toEqual(['host000000000001', 'host000000000004'])
  })

  it('degrades to one statement per host when the batch statement fails', async () => {
    const probe = new RenewalStatementProbe(() => 'renewed')
    probe.failuresRemaining = 1
    const store = new RelayAssignmentStore(probe, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const outcomes = await store.renewControlActivities([
        renewal('user-a', 'host000000000001'),
        renewal('user-a', 'host000000000002')
      ])

      expect(outcomes).toEqual(['renewed', 'renewed'])
      expect(probe.statements).toHaveLength(3)
      expect(probe.statements[1]!.params[1]).toEqual(['host000000000001'])
      expect(probe.statements[2]!.params[1]).toEqual(['host000000000002'])
      expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({
        event: 'orca_relay_control_renewal_batch_failed',
        rows: 2
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('reports a host that fails its own fallback statement without touching the rest', async () => {
    const probe = new RenewalStatementProbe(() => 'renewed')
    probe.failuresRemaining = 2
    const store = new RelayAssignmentStore(probe, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const outcomes = await store.renewControlActivities([
        renewal('user-a', 'host000000000001'),
        renewal('user-a', 'host000000000002')
      ])

      expect(outcomes.filter((outcome) => outcome === 'renewed')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === 'database_error')).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('reports a contended assignment row apart from a missing one', async () => {
    const probe = new RenewalStatementProbe((userId) =>
      userId === 'user-b' ? 'assignment_lock_unavailable' : 'renewed'
    )
    const store = new RelayAssignmentStore(probe, () => now)

    const outcomes = await store.renewControlActivities([
      renewal('user-a', 'host000000000001'),
      renewal('user-b', 'host000000000002')
    ])

    // Retryable: SKIP LOCKED passed over the row rather than queueing the whole
    // flush behind whoever held it.
    expect(outcomes).toEqual(['renewed', 'assignment_lock_unavailable'])
  })

  it('counts a lone renewal that threw before rethrowing it', async () => {
    const probe = new RenewalStatementProbe(() => 'renewed')
    probe.failuresRemaining = 1
    const recordControlRenewal = vi.fn()
    const store = new RelayAssignmentStore(probe, () => now, { recordControlRenewal })

    // A one-row flush keeps the pre-batch contract and rethrows, but the metric
    // still owes an outcome for the attempt.
    await expect(
      store.renewControlActivities([renewal('user-a', 'host000000000001')])
    ).rejects.toThrow('statement timeout')

    expect(recordControlRenewal).toHaveBeenCalledTimes(1)
    expect(recordControlRenewal.mock.calls[0]![1]).toBe('database_error')
  })

  it('counts a batch in which every row was rejected before the statement', async () => {
    const probe = new RenewalStatementProbe(() => 'renewed')
    const recordControlRenewal = vi.fn()
    const store = new RelayAssignmentStore(probe, () => now, { recordControlRenewal })

    const outcomes = await store.renewControlActivities([
      { ...renewal('user-a', 'host000000000001'), activityId: '' },
      renewal('user-a', 'host000000000002', now - 1)
    ])

    expect(outcomes).toEqual(['invalid_activity_id', 'invalid_activity_expiry'])
    expect(probe.statements).toHaveLength(0)
    expect(recordControlRenewal.mock.calls.map((call) => call[1])).toEqual([
      'invalid_activity_id',
      'invalid_activity_expiry'
    ])
  })

  it('counts one renewal metric per row against the flush latency', async () => {
    const probe = new RenewalStatementProbe((userId) =>
      userId === 'user-b' ? 'assignment_not_found' : 'renewed'
    )
    const recordControlRenewal = vi.fn()
    const store = new RelayAssignmentStore(probe, () => now, { recordControlRenewal })

    await store.renewControlActivities([
      renewal('user-a', 'host000000000001'),
      renewal('user-b', 'host000000000002')
    ])

    expect(recordControlRenewal).toHaveBeenCalledTimes(2)
    expect(recordControlRenewal.mock.calls.map((call) => call[1])).toEqual([
      'renewed',
      'assignment_not_found'
    ])
  })
})

describe('batched control renewals on SQLite', () => {
  it('renews every host through the transactional path', async () => {
    let clock = now
    const database = await openInMemoryRelayDatabase()
    try {
      const store = new RelayAssignmentStore(database, () => clock)
      await store.reconcileCells([
        { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 }
      ])
      const hosts = ['host000000000001', 'host000000000002']
      const requests = []
      for (const relayHostId of hosts) {
        const identity = { userId: 'user-a', relayHostId }
        const assignment = await store.assign(identity)
        await store.activateControl(identity, {
          cellId: assignment.cellId,
          assignmentEpoch: assignment.assignmentEpoch,
          generation: 1
        })
        requests.push({
          identity,
          activityId: `control:${assignment.cellId}:1`,
          cellId: assignment.cellId,
          expiresAt: clock + 105_000
        })
      }
      // A host with no assignment at all must not cost the others their renewal.
      requests.push({
        identity: { userId: 'user-a', relayHostId: 'host000000000009' },
        activityId: 'control:cell-a:1',
        cellId: 'cell-a',
        expiresAt: clock + 105_000
      })
      clock += 1_000

      const outcomes = await store.renewControlActivities(requests)

      expect(outcomes).toEqual(['renewed', 'renewed', 'assignment_not_found'])
      const leases = await database.query(
        `SELECT relay_host_id, expires_at FROM relay_assignment_activity_leases
         WHERE user_id = ? ORDER BY relay_host_id ASC`,
        ['user-a']
      )
      expect(leases.map((lease) => Number(lease.expires_at))).toEqual([
        now + 105_000,
        now + 105_000
      ])
    } finally {
      await database.close()
    }
  })
})
