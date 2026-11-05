import { describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from '../assignment/assignment-store.js'
import { openInMemoryRelayDatabase } from '../database/database.js'

const now = 1_900_000_000_000

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
