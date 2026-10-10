import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const identity = { userId: 'restart-test-user', relayHostId: 'abcdefghijklmnop' }
const paths: string[] = []
const databases = new Set<RelayDatabase>()
afterEach(async () => {
  for (const database of databases) await database.close()
  databases.clear()
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-region-restart-'))
  paths.push(dataDir)
  let now = 1_000_000_000
  const open = async () => {
    const database = await openRelayDatabase({ dataDir })
    databases.add(database)
    return { database, store: new RelayAssignmentStore(database, () => now) }
  }
  const first = await open()
  const cell = {
    id: 'restart-us',
    url: 'https://restart-us.example.test',
    region: 'us-central1' as const,
    capacityRequests: 100
  }
  await first.store.reconcileCells([cell])
  await first.store.setCellEnabled(cell.id, true)
  await first.store.recordCellHeartbeat({
    cellId: cell.id,
    cellUrl: cell.url,
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    region: cell.region,
    startedAt: now - 1_000,
    ready: true,
    observedRequests: 0
  })
  const assignment = await first.store.assign(identity)
  const issue = (store: RelayAssignmentStore) =>
    store.exchangeRegionCorrection(identity, { v: 1, action: 'issue-window' }, assignment.assignmentEpoch)
  const window = (await issue(first.store)).window!
  const report = {
    v: 1 as const,
    action: 'report' as const,
    generation: window.generation,
    assignmentEpoch: window.assignmentEpoch,
    policyVersion: 1 as const,
    outcome: 'conclusive' as const,
    measurements: { 'us-central1': 200, 'asia-east2': 40 }
  }
  const restart = async () => {
    await first.database.close()
    databases.delete(first.database)
    return open()
  }
  return {
    ...first, window, report, issue, restart,
    setNow: (value: number) => { now = value }
  }
}

describe('persisted region decisions across director restart', () => {
  it('keeps tombstones and fixed expiry, then invalidates the prior generation after restart', async () => {
    const context = await setup()
    const epoch = context.window.assignmentEpoch
    await context.store.exchangeRegionCorrection(identity, {
      v: 1, action: 'report', generation: context.window.generation,
      assignmentEpoch: epoch, policyVersion: 1, outcome: 'inconclusive', reason: 'jitter'
    }, epoch)
    const restarted = await context.restart()
    expect(await restarted.store.exchangeRegionCorrection(identity, context.report, epoch))
      .toMatchObject({ reportStatus: 'duplicate' })
    const row = (await restarted.database.query('SELECT * FROM relay_region_decisions'))[0]!
    expect(row.outcome).toBe('inconclusive')
    expect(Number(row.expires_at)).toBe(context.window.expiresAt)
    const successor = (await context.issue(restarted.store)).window!
    expect(successor.generation).toBe(context.window.generation + 1)
    expect(await restarted.store.exchangeRegionCorrection(identity, context.report, epoch))
      .toMatchObject({ reportStatus: 'stale' })
  })

  it('uses server expiry after a restart regardless of an old client report', async () => {
    const context = await setup()
    context.setNow(context.window.expiresAt)
    const restarted = await context.restart()
    expect(await restarted.store.exchangeRegionCorrection(identity, context.report, context.window.assignmentEpoch))
      .toMatchObject({ reportStatus: 'expired' })
    expect(await restarted.store.previewRegionCorrection()).toEqual({ expired: 1 })
  })

  it('does not interpret a persisted future-policy window using the old policy after rollback', async () => {
    const context = await setup()
    await context.database.query('UPDATE relay_region_decisions SET policy_version = 2')
    const restarted = await context.restart()
    expect(await restarted.store.exchangeRegionCorrection(identity, context.report, context.window.assignmentEpoch))
      .toMatchObject({ reportStatus: 'stale' })
    const row = (await restarted.database.query('SELECT * FROM relay_region_decisions'))[0]!
    expect(row.outcome).toBe('pending')
    expect(row.preferred_region).toBeNull()
    expect(row.report_json).toBeNull()
  })

  it('keeps generation ordering when the server clock moves backwards across restart', async () => {
    const context = await setup()
    context.setNow(1_000_000_000 - 60_000)
    const restarted = await context.restart()
    const successor = (await context.issue(restarted.store)).window!
    expect(successor.generation).toBe(context.window.generation + 1)
    expect(successor.expiresAt).toBe(context.window.expiresAt - 60_000)
    expect(await restarted.store.exchangeRegionCorrection(identity, context.report, context.window.assignmentEpoch))
      .toMatchObject({ reportStatus: 'stale' })
  })
})
