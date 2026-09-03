import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const cell = {
  id: 'legacy-fence-adoption-postgres',
  url: 'https://legacy-fence-adoption-postgres.example.com',
  capacityRequests: 100
}
const incarnation = '11111111-1111-4111-8111-111111111111'
const attemptId = '22222222-2222-4222-8222-222222222222'

describePostgres('PostgreSQL legacy fence adoption', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    databases.push(
      await openRelayDatabase({ databaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl, dataDir: '' })
    )
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    for (const database of databases) await database.close()
  })

  async function cleanup(): Promise<void> {
    const database = databases[0]
    if (!database) return
    await database.query(
      `DELETE FROM relay_cell_fence_plan_bindings WHERE attempt_id = ?`,
      [attemptId]
    )
    await database.query(
      `DELETE FROM relay_cell_fence_apply_invocations WHERE attempt_id = ?`,
      [attemptId]
    )
    await database.query(`DELETE FROM relay_cell_committed_fences WHERE cell_id = ?`, [
      cell.id
    ])
    await database.query(
      `DELETE FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
      [cell.id]
    )
    await database.query(`DELETE FROM relay_cell_fence_attempts WHERE cell_id = ?`, [cell.id])
    await database.query(`DELETE FROM relay_cell_fences WHERE cell_id = ?`, [cell.id])
    await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id = ?`, [cell.id])
    await database.query(`DELETE FROM relay_cell_admission WHERE cell_id = ?`, [cell.id])
    await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [cell.id])
  }

  it('allows either adoption or attempt preparation, never both', async () => {
    let now = 100
    const stores = databases.map(
      (database) =>
        new RelayAssignmentStore(database, () => now, {
          requireLiveCells: true,
          heartbeatTtlMs: 45_000
        })
    )
    await stores[0]!.reconcileCells([cell], false)
    await stores[0]!.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: incarnation,
      startedAt: 50,
      ready: true,
      observedRequests: 0
    })
    await stores[0]!.setCellEnabled(cell.id, false)
    now += 45_001
    const evidence = {
      attemptId,
      environment: 'production' as const,
      cellId: cell.id,
      cellIncarnation: incarnation,
      migName: 'orca-relay-c3',
      instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c3',
      generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c3-abc',
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      planObjectName:
        'terraform/state/relay-fence-plans/production/22222222-2222-4222-8222-222222222222.tfplan',
      planObjectGeneration: '123456789',
      varFileSha256: 'c'.repeat(64),
      terraformStateLineage: '33333333-3333-4333-8333-333333333333',
      terraformStateSerial: 7,
      terraformStateObjectGeneration: '987654321',
      terraformStateObjectSha256: 'd'.repeat(64),
      requestReason:
        'orca-relay-fence/22222222-2222-4222-8222-222222222222'
    }

    const results = await Promise.allSettled([
      stores[0]!.adoptLegacyCellFence(cell.id, incarnation),
      stores[1]!.prepareCellFenceAttempt(evidence)
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    if (results[0]!.status === 'fulfilled') {
      await stores[0]!.commitLegacyCellFenceAdoption(cell.id, incarnation)
    }
    const attempts = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_cell_fence_attempts WHERE cell_id = ?`,
      [cell.id]
    )
    const fences = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_cell_fences WHERE cell_id = ?`,
      [cell.id]
    )
    const adoptions = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
      [cell.id]
    )
    expect(Number(attempts[0]!.count) + Number(fences[0]!.count)).toBe(1)
    expect(Number(adoptions[0]!.count)).toBe(Number(fences[0]!.count))
  })
})
