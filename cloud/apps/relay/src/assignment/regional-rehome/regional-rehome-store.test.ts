import { describe, expect, it } from 'vitest'
import {
  RelayAssignmentStore as BaseRelayAssignmentStore,
  type RegionalRehomeAttempt
} from '../assignment-store.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase
} from '../../database/database.js'
import type { RegionalRehomeSafetySnapshot } from '../../observability/relay-observability.js'

const source = {
  id: 'us-c1',
  url: 'https://us-c1.relay.example.test',
  region: 'us-central1' as const,
  capacityRequests: 100,
  connectionHardCap: 1_000 as const,
  connectionUnobservedBound: 60
}
const target = {
  id: 'asia-c1',
  url: 'https://asia-c1.relay.example.test',
  region: 'asia-east2' as const,
  capacityRequests: 100,
  connectionHardCap: 1_000 as const,
  connectionUnobservedBound: 60
}
const sourceIncarnation = '11111111-1111-4111-8111-111111111111'
const targetIncarnation = '22222222-2222-4222-8222-222222222222'

describe('regional rehome assignment state', () => {

  it('moves one live preferred host and completes without disabling its source cell', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const neighbor = { userId: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const sourceControl = await activatePreferredSource(context, identity)
    await activateSource(context, neighbor)

    const attempt = await context.store.tryIdleRehome()
    expect(attempt).toMatchObject({
      userId: identity.userId,
      relayHostId: identity.relayHostId,
      sourceCellId: source.id,
      sourceCellIncarnation: sourceIncarnation,
      targetCellId: target.id,
      targetCellIncarnation: targetIncarnation,
      previousEpoch: 1,
      assignmentEpoch: 2,
      sendAttempts: 1
    })
    expect(await context.store.resolve(neighbor)).toMatchObject({ cellId: source.id })
    expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    expect(
      await context.database.query(
        'SELECT drain_outcome FROM relay_region_rehome_attempts WHERE attempt_id = ?',
        [attempt!.attemptId]
      )
    ).toEqual([{ drain_outcome: 'accepted' }])

    const targetControl = await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })
    expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    await context.store.releaseActivity(identity, sourceControl)
    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)

    expect(await context.store.resolve(identity)).toMatchObject({
      cellId: target.id,
      assignmentEpoch: 2
    })
    expect(await context.store.resolve(neighbor)).toMatchObject({ cellId: source.id })
    expect(
      await context.database.query(
        `SELECT completed_at, aborted_at FROM relay_assignment_migrations
       WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ completed_at: context.now(), aborted_at: null }])
    expect(
      await context.database.query(
        `SELECT drain_receipt_at, completed_at, aborted_at FROM relay_region_rehome_attempts`
      )
    ).toEqual([{ drain_receipt_at: context.now(), completed_at: context.now(), aborted_at: null }])
    expect(targetControl).toMatch(/^control:/)
    await context.database.close()
  })

  it('does not roll an unregistered target back to a stale regional source', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    await context.store.tryIdleRehome()
    context.advance(6 * 60_000)
    await heartbeat(context.store, target, targetIncarnation, 3, 2)

    expect(await context.store.refreshRegionalRehomeLeases()).toBe(0)
    expect(await context.store.abortExpiredEvacuations()).toBe(0)
    expect(
      await context.database.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: target.id, assignment_epoch: 2 }])
    await context.database.close()
  })

  it('completes healthy candidates past a poisoned attempt and logs it', async () => {
    const context = await setup()
    const poisoned = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const healthy = { userId: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const poisonedSource = await activatePreferredSource(context, poisoned)
    const healthySource = await activatePreferredSource(context, healthy)
    const first = await context.store.tryIdleRehome()
    context.advance(6_000)
    const second = await context.store.tryIdleRehome()
    expect(first!.userId).toBe(poisoned.userId)
    expect(second!.userId).toBe(healthy.userId)
    for (const [identity, attempt, sourceControl] of [
      [poisoned, first, poisonedSource],
      [healthy, second, healthySource]
    ] as const) {
      await context.store.activateControl(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch,
        generation: 1
      })
      await context.store.markMigrationTargetRegistered(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch
      })
      await context.store.releaseActivity(identity, sourceControl)
    }
    // The production poison shape: the assignment moved past the attempt.
    await context.database.query(
      `UPDATE relay_assignments SET assignment_epoch = assignment_epoch + 5
       WHERE user_id = ?`,
      [poisoned.userId]
    )
    const warnings = collectCandidateFailureWarnings()
    try {
      expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([
      {
        event: 'orca_relay_regional_rehome_candidate_failed',
        operation: 'complete',
        attemptId: first!.attemptId,
        reason: 'regional_rehome_assignment_mismatch'
      }
    ])
    expect(
      await context.database.query(
        `SELECT completed_at FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
        [second!.attemptId]
      )
    ).toEqual([{ completed_at: context.now() }])
    await context.database.close()
  })

  it('keeps dual-control accounting when the drained host re-resolves mid-rehome', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.tryIdleRehome()
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 2,
      controlLeases: 2
    })

    // The drained host re-resolves through the director while both the source
    // control and the target's pending control are still live.
    await context.store.assign(identity, 'asia-east2')
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 2,
      controlLeases: 2
    })

    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(identity, sourceControl)
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 1,
      controlLeases: 1
    })

    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    expect(
      await context.database.query(
        `SELECT completed_at FROM relay_assignment_migrations
       WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ completed_at: context.now() }])
    expect(await cellReservations(context)).toEqual({ [source.id]: 0, [target.id]: 1 })
    await context.database.close()
  })

})

type Context = Awaited<ReturnType<typeof setup>>

async function setup(
  options: {
    sourceProtocol?: number
    targetProtocol?: number
    hostCooldownMs?: number
    database?: RelayDatabase
    wrap?: (database: RelayDatabase) => RelayDatabase
  } = {}
) {
  let clock = 1_000_000
  const database = options.database ?? (await openInMemoryRelayDatabase())
  const store = new IdleRehomeTestStore(options.wrap?.(database) ?? database, () => clock, {
    regionalRehomeCohortPercent: 100,
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
  await store.inspectRegionalRehomeControl()
  clock += 24 * 60 * 60_000
  await store.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: clock,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 24 * 60 * 60_000,
    hostCooldownMs: options.hostCooldownMs ?? 7 * 24 * 60 * 60_000,
    drainGraceMs: 60 * 60_000
  })
  await store.reconcileCells([source, target])
  await heartbeat(store, source, sourceIncarnation, options.sourceProtocol ?? 3)
  await heartbeat(store, target, targetIncarnation, options.targetProtocol ?? 3)
  return {
    database,
    store,
    now: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds
    }
  }
}

function collectCandidateFailureWarnings(
  events: string[] = ['orca_relay_regional_rehome_candidate_failed']
) {
  const entries: Record<string, unknown>[] = []
  const original = console.warn
  console.warn = (line: unknown, ...rest: unknown[]) => {
    try {
      const parsed = JSON.parse(line as string) as Record<string, unknown>
      if (events.includes(parsed.event as string)) {
        entries.push(parsed)
        return
      }
    } catch {
      // fall through to the real console for non-JSON lines
    }
    original(line, ...rest)
  }
  return {
    entries,
    restore: () => {
      console.warn = original
    }
  }
}

async function controlAccounting(
  context: Context,
  identity: { userId: string; relayHostId: string }
): Promise<{ reservedControls: number; controlLeases: number }> {
  const assignment = (
    await context.database.query(
      `SELECT reserved_controls FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
  )[0]!
  const leases = await context.database.query(
    `SELECT COUNT(*) AS controls FROM relay_assignment_activity_leases
     WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'`,
    [identity.userId, identity.relayHostId]
  )
  return {
    reservedControls: Number(assignment.reserved_controls),
    controlLeases: Number(leases[0]!.controls)
  }
}

async function cellReservations(context: Context): Promise<Record<string, number>> {
  const rows = await context.database.query(
    `SELECT cell_id, reserved_requests FROM relay_cells ORDER BY cell_id`
  )
  return Object.fromEntries(rows.map((row) => [String(row.cell_id), Number(row.reserved_requests)]))
}

async function activatePreferredSource(
  context: Context,
  identity: { userId: string; relayHostId: string }
): Promise<string> {
  const assignment = await context.store.assign(identity, undefined, 'us-central1')
  const control = await context.store.activateControl(identity, {
    cellId: source.id,
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 1,
    idleRegionalRehome: true,
    cellIncarnation: sourceIncarnation
  })
  await context.store.assign(identity, 'asia-east2')
  const issued = await context.store.exchangeRegionCorrection(
    identity,
    { v: 1, action: 'issue-window' },
    assignment.assignmentEpoch
  )
  await context.store.exchangeRegionCorrection(
    identity,
    {
      v: 1,
      action: 'report',
      generation: issued.window!.generation,
      assignmentEpoch: assignment.assignmentEpoch,
      policyVersion: 1,
      outcome: 'conclusive',
      measurements: { 'us-central1': 150, 'asia-east2': 50 }
    },
    assignment.assignmentEpoch
  )
  return control
}

async function activateSource(
  context: Context,
  identity: { userId: string; relayHostId: string }
): Promise<string> {
  const assignment = await context.store.assign(identity, undefined, 'us-central1')
  return await context.store.activateControl(identity, {
    cellId: source.id,
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 1
  })
}

async function heartbeat(
  store: IdleRehomeTestStore,
  cell: typeof source | typeof target,
  cellIncarnation: string,
  regionalRehomeProtocol: number,
  connectionInclusionWatermark = 1,
  regionalRehomeSafety?: RegionalRehomeSafetySnapshot
): Promise<void> {
  await store.recordCellHeartbeat({
    cellId: cell.id,
    cellUrl: cell.url,
    region: cell.region,
    cellIncarnation,
    startedAt: 900_000,
    ready: true,
    observedRequests: 0,
    totalConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    connectionInclusionWatermark,
    connectionHardCap: 1_000,
    connectionUnobservedBound: 60
  })
  await store.recordCellRegionalRehomeStatus({
    cellId: cell.id,
    cellIncarnation,
    regionalRehomeProtocol,
    safety: regionalRehomeSafety ?? {
      observedAt: 1_000_000 + 24 * 60 * 60_000,
      sqlFailures: 0,
      reconnects: 0,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    }
  })
}

class IdleRehomeTestStore extends BaseRelayAssignmentStore {
  private readonly fixtureDatabase: RelayDatabase
  private readonly fixtureNow: () => number
  constructor(...args: ConstructorParameters<typeof BaseRelayAssignmentStore>) {
    super(...args)
    this.fixtureDatabase = args[0]
    this.fixtureNow = args[1] ?? Date.now
  }
  async tryIdleRehome(
    processSafety?: RegionalRehomeSafetySnapshot
  ): Promise<RegionalRehomeAttempt | null> {
    const safety = processSafety ?? {
      observedAt: this.fixtureNow(),
      sqlFailures: 0,
      reconnects: 0,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    }
    for (const candidate of await this.selectIdleRegionalRehomeCandidates(safety)) {
      const result = await this.commitIdleRegionalRehome(candidate, safety)
      if (result.outcome !== 'committed') continue
      const row = (
        await this.fixtureDatabase.query(
          'SELECT * FROM relay_region_rehome_attempts WHERE attempt_id = ?',
          [candidate.attemptId]
        )
      )[0]!
      return {
        ...candidate,
        preferredRegion: row.preferred_region as RegionalRehomeAttempt['preferredRegion'],
        targetCellIncarnation: String(row.target_cell_incarnation),
        previousEpoch: Number(row.previous_epoch),
        assignmentEpoch: Number(row.assignment_epoch),
        drainGraceMs: Number(row.drain_grace_ms),
        sendAttempts: Number(row.send_attempts)
      }
    }
    return null
  }
}
