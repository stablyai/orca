import { describe, expect, it } from 'vitest'
import {
  evaluateIncidentSample,
  INCIDENT_CHECKPOINT_MINUTES,
  INCIDENT_MONITOR_THRESHOLDS,
  INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS,
  initialIncidentMonitorState,
  preDrainDryRunPassed,
  runIncidentMonitor,
  type IncidentSample
} from './incident-monitor.js'

const startedAt = Date.parse('2026-07-28T00:00:00.000Z')
const selector = {
  generation: 1,
  membership: {
    existingOnly: [],
    migrationOnly: [],
    general: ['production-gce-c1']
  }
}
const signal = (value: number, at = startedAt) => ({
  value,
  observedAt: new Date(at).toISOString()
})

function healthySample(at = startedAt): IncidentSample {
  const observedAt = new Date(at).toISOString()
  return {
    collectedAt: observedAt,
    selector,
    expectedSelector: selector,
    cells: [{
      cellId: 'production-gce-c1',
      runtimeKnown: true,
      powered: true,
      expectedAdmissionState: 'general'
    }],
    sources: {
      'active-probe': {
        observedAt,
        signals: {
          'director.health': signal(1, at),
          'director.ready': signal(1, at),
          'director.latency_ms': signal(100, at),
          'auth.health': signal(1, at),
          'auth.ready': signal(1, at),
          'auth.latency_ms': signal(100, at),
          'cell.production-gce-c1.health': signal(1, at),
          'cell.production-gce-c1.ready': signal(1, at),
          'cell.production-gce-c1.latency_ms': signal(100, at)
        }
      },
      'cloud-monitoring': {
        observedAt,
        signals: {
          'cloud_sql.cpu': signal(0.2, at),
          'cloud_sql.memory': signal(0.3, at),
          'cloud_sql.backends': signal(12, at),
          'cloud_sql.lock_waits': signal(0, at),
          'cloud_sql.deadlocks': signal(0, at),
          'director.instances': signal(5, at),
          'director.cpu': signal(0.2, at),
          'director.memory': signal(0.3, at),
          'director.concurrency': signal(5, at),
          'director.errors': signal(0, at),
          'auth.errors': signal(0, at)
        }
      },
      'relay-logs': {
        observedAt,
        signals: {
          'relay.pool_waiting': signal(0, at),
          'relay.pool_wait_ms': signal(1, at),
          'relay.postgres_retries': signal(0, at),
          'relay.postgres_retry_exhausted': signal(0, at),
          'cell.production-gce-c1.connections': signal(100, at),
          'cell.production-gce-c1.queued_bytes': signal(0, at)
        }
      },
      'director-admin': {
        observedAt,
        signals: {
          'cell.production-gce-c1.admission_state': signal(2, at),
          'cell.production-gce-c1.heartbeat_fresh': signal(1, at),
          'cell.production-gce-c1.heartbeat_age_ms': signal(1_000, at),
          'cell.production-gce-c1.migration_blocked': signal(0, at),
          'cell.production-gce-c1.migration_target_inactive': signal(0, at)
        }
      }
    }
  }
}

describe('incident monitor evaluator', () => {
  it('accepts a complete fresh sample at every exact boundary', () => {
    const sample = healthySample()
    sample.sources['active-probe']!.signals['director.latency_ms'] =
      signal(INCIDENT_MONITOR_THRESHOLDS.endpointLatencyMs)
    sample.sources['cloud-monitoring']!.signals['cloud_sql.cpu'] =
      signal(INCIDENT_MONITOR_THRESHOLDS.cloudSqlCpuUtilization)
    sample.sources['relay-logs']!.signals['relay.pool_wait_ms'] =
      signal(INCIDENT_MONITOR_THRESHOLDS.relayPoolWaitMs)
    sample.sources['relay-logs']!.signals['relay.postgres_retries'] =
      signal(INCIDENT_MONITOR_THRESHOLDS.relayPostgresRetries)
    sample.sources['cloud-monitoring']!.signals['cloud_sql.backends'] =
      signal(INCIDENT_MONITOR_THRESHOLDS.cloudSqlBackends)
    expect(evaluateIncidentSample(sample, startedAt)).toMatchObject({
      status: 'green',
      failures: []
    })
  })

  it('freezes when postgres retries exceed the recalibrated ceiling', () => {
    const sample = healthySample()
    sample.sources['relay-logs']!.signals['relay.postgres_retries'] =
      signal(INCIDENT_MONITOR_THRESHOLDS.relayPostgresRetries + 1)
    expect(evaluateIncidentSample(sample, startedAt)).toMatchObject({
      status: 'freeze',
      failures: [
        expect.objectContaining({ signal: 'relay.postgres_retries', threshold: 300 })
      ]
    })
  })

  it('allows missing auth readiness and legacy existing-only connections', () => {
    const sample = healthySample()
    const legacySelector = {
      generation: 1,
      membership: {
        existingOnly: ['production-gce-c1'],
        migrationOnly: [],
        general: []
      }
    }
    sample.selector = legacySelector
    sample.expectedSelector = legacySelector
    sample.cells[0]!.expectedAdmissionState = 'existing-only'
    delete sample.sources['active-probe']!.signals['auth.ready']
    sample.sources['relay-logs']!.signals['cell.production-gce-c1.connections'] =
      signal(900)
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.admission_state'
    ] = signal(0)
    expect(evaluateIncidentSample(sample, startedAt)).toMatchObject({
      status: 'green',
      failures: []
    })
  })

  it('fails loudly on every missing or stale source', () => {
    const missing = healthySample()
    delete missing.sources['relay-logs']
    expect(evaluateIncidentSample(missing, startedAt).failures).toContainEqual({
      code: 'source_missing',
      source: 'relay-logs'
    })
    const stale = healthySample(startedAt - 180_001)
    const failures = evaluateIncidentSample(stale, startedAt).failures
    expect(failures.some((failure) => failure.source === 'cloud-monitoring')).toBe(true)
    expect(failures.some((failure) => failure.source === 'active-probe')).toBe(true)
  })

  it('freezes on SQL, director, relay pool, heartbeat, and migration breaches', () => {
    const sample = healthySample()
    sample.sources['cloud-monitoring']!.signals['cloud_sql.cpu'] = signal(0.81)
    sample.sources['cloud-monitoring']!.signals['director.instances'] = signal(7)
    sample.sources['relay-logs']!.signals['relay.pool_waiting'] = signal(801)
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.heartbeat_age_ms'
    ] = signal(45_001)
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_blocked'
    ] = signal(1)
    sample.sources['relay-logs']!.signals['cell.production-gce-c1.connections'] =
      signal(501)
    const evaluation = evaluateIncidentSample(sample, startedAt)
    expect(evaluation.status).toBe('freeze')
    expect(evaluation.failures.map((failure) => failure.signal)).toEqual(
      expect.arrayContaining([
        'cloud_sql.cpu',
        'director.instances',
        'relay.pool_waiting',
        'cell.production-gce-c1.connections',
        'cell.production-gce-c1.heartbeat_age_ms',
        'cell.production-gce-c1.migration_blocked'
      ])
    )
  })

  it('uses each cell reported physical connection cap', () => {
    const sample = healthySample()
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.connection_hard_cap'
    ] = signal(1_000)
    sample.sources['relay-logs']!.signals['cell.production-gce-c1.connections'] =
      signal(999)

    expect(evaluateIncidentSample(sample, startedAt).status).toBe('green')
    sample.sources['relay-logs']!.signals['cell.production-gce-c1.connections'] =
      signal(1_000)
    expect(evaluateIncidentSample(sample, startedAt).status).toBe('freeze')
  })

  it('allows five active directors plus the warm rollback', () => {
    const sample = healthySample()
    sample.sources['cloud-monitoring']!.signals['director.instances'] = signal(6)
    expect(evaluateIncidentSample(sample, startedAt).status).toBe('green')
  })

  it('allows bounded relay pool waiting below the latency ceiling', () => {
    const sample = healthySample()
    sample.sources['relay-logs']!.signals['relay.pool_waiting'] = signal(800)
    sample.sources['relay-logs']!.signals['relay.pool_wait_ms'] = signal(2_500)
    expect(evaluateIncidentSample(sample, startedAt)).toMatchObject({
      status: 'green',
      failures: []
    })
    sample.sources['relay-logs']!.signals['relay.pool_wait_ms'] = signal(2_501)
    expect(evaluateIncidentSample(sample, startedAt).failures).toContainEqual({
      code: 'threshold_max',
      source: 'relay-logs',
      signal: 'relay.pool_wait_ms',
      observed: 2_501,
      threshold: 2_500
    })
  })

  it('bounds Cloud SQL backends above measured healthy peaks', () => {
    const sample = healthySample()
    sample.sources['cloud-monitoring']!.signals['cloud_sql.backends'] = signal(250)
    expect(evaluateIncidentSample(sample, startedAt).status).toBe('green')
    sample.sources['cloud-monitoring']!.signals['cloud_sql.backends'] = signal(251)
    expect(evaluateIncidentSample(sample, startedAt).failures).toContainEqual({
      code: 'threshold_max',
      source: 'cloud-monitoring',
      signal: 'cloud_sql.backends',
      observed: 251,
      threshold: 250
    })
  })

  it('bounds SQL lock waiters and keeps deadlocks zero-tolerance', () => {
    const sample = healthySample()
    sample.sources['cloud-monitoring']!.signals['cloud_sql.lock_waits'] = signal(20)
    expect(evaluateIncidentSample(sample, startedAt)).toMatchObject({
      status: 'green',
      failures: []
    })
    sample.sources['cloud-monitoring']!.signals['cloud_sql.lock_waits'] = signal(21)
    expect(evaluateIncidentSample(sample, startedAt).failures).toContainEqual({
      code: 'threshold_max',
      source: 'cloud-monitoring',
      signal: 'cloud_sql.lock_waits',
      observed: 21,
      threshold: 20
    })
    sample.sources['cloud-monitoring']!.signals['cloud_sql.lock_waits'] = signal(0)
    sample.sources['cloud-monitoring']!.signals['cloud_sql.deadlocks'] = signal(1)
    expect(evaluateIncidentSample(sample, startedAt).failures).toContainEqual({
      code: 'threshold_max',
      source: 'cloud-monitoring',
      signal: 'cloud_sql.deadlocks',
      observed: 1,
      threshold: 0
    })
  })

  it('allows only registered target inactivity during forward recovery', () => {
    const sample = healthySample()
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_target_inactive'
    ] = signal(40)
    expect(evaluateIncidentSample(sample, startedAt).failures).toContainEqual({
      code: 'threshold_max',
      source: 'director-admin',
      signal: 'cell.production-gce-c1.migration_target_inactive',
      observed: 40,
      threshold: 0
    })
    expect(
      evaluateIncidentSample(
        sample,
        startedAt,
        'recover-forward',
        'production-gce-c1'
      )
    ).toMatchObject({
      status: 'green',
      failures: []
    })
    expect(
      evaluateIncidentSample(
        sample,
        startedAt,
        'recover-forward',
        'production-gce-c2'
      ).failures
    ).toContainEqual(expect.objectContaining({
      signal: 'cell.production-gce-c1.migration_target_inactive'
    }))
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_blocked'
    ] = signal(1)
    expect(
      evaluateIncidentSample(
        sample,
        startedAt,
        'recover-forward',
        'production-gce-c1'
      ).failures
    ).toContainEqual({
      code: 'threshold_max',
      source: 'director-admin',
      signal: 'cell.production-gce-c1.migration_blocked',
      observed: 1,
      threshold: 0
    })
  })

  it('scopes registered target inactivity to the capacity cell', () => {
    const sample = healthySample()
    const scopedSelector = {
      generation: 1,
      membership: {
        existingOnly: ['production-gce-c1'],
        migrationOnly: [],
        general: ['production-gce-c2', 'production-gce-c3']
      }
    }
    sample.selector = scopedSelector
    sample.expectedSelector = scopedSelector
    sample.cells[0]!.expectedAdmissionState = 'existing-only'
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.admission_state'
    ] = signal(0)
    sample.cells.push({
      cellId: 'production-gce-c2',
      runtimeKnown: true,
      powered: true,
      expectedAdmissionState: 'general'
    })
    sample.cells.push({
      cellId: 'production-gce-c3',
      runtimeKnown: true,
      powered: true,
      expectedAdmissionState: 'general'
    })
    for (const sourceName of ['active-probe', 'relay-logs', 'director-admin'] as const) {
      const signals = sample.sources[sourceName]!.signals
      for (const [name, value] of Object.entries(signals)) {
        if (name.includes('production-gce-c1')) {
          for (const cellId of ['production-gce-c2', 'production-gce-c3']) {
            signals[name.replace('production-gce-c1', cellId)] = value
          }
        }
      }
    }
    for (const cellId of ['production-gce-c2', 'production-gce-c3']) {
      sample.sources['director-admin']!.signals[
        `cell.${cellId}.admission_state`
      ] = signal(2)
    }
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_target_inactive'
    ] = signal(40)
    expect(
      evaluateIncidentSample(
        sample,
        startedAt,
        'capacity-transition',
        null,
        'production-gce-c2'
      )
    ).toMatchObject({ status: 'green', failures: [] })
    expect(
      evaluateIncidentSample(
        sample,
        startedAt,
        'capacity-transition',
        null,
        'production-gce-c3'
      )
    ).toMatchObject({ status: 'green', failures: [] })
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c2.migration_target_inactive'
    ] = signal(1)
    expect(
      evaluateIncidentSample(
        sample,
        startedAt,
        'capacity-transition',
        null,
        'production-gce-c2'
      ).failures
    ).toContainEqual(expect.objectContaining({
      signal: 'cell.production-gce-c2.migration_target_inactive'
    }))
  })

  it('freezes when expected admission has no powered runtime', () => {
    const sample = healthySample()
    sample.cells[0]!.powered = false
    const evaluation = evaluateIncidentSample(sample, startedAt)
    expect(evaluation.failures).toContainEqual({
      code: 'expected_admission_without_runtime',
      source: 'director-admin',
      signal: 'cell.production-gce-c1.powered',
      observed: 0,
      threshold: 1
    })
  })

  it('ignores stale runtime signals for an expected offline existing-only cell', () => {
    const sample = healthySample()
    sample.cells[0] = {
      ...sample.cells[0]!,
      powered: false,
      expectedAdmissionState: 'existing-only'
    }
    sample.expectedSelector = {
      generation: sample.expectedSelector.generation,
      membership: {
        existingOnly: ['production-gce-c1'],
        migrationOnly: [],
        general: []
      }
    }
    sample.selector = sample.expectedSelector
    sample.sources['active-probe']!.signals['cell.production-gce-c1.health'] = signal(0)
    sample.sources['active-probe']!.signals['cell.production-gce-c1.ready'] = signal(0)
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.admission_state'
    ] = signal(0)
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.heartbeat_fresh'
    ] = signal(0)
    sample.sources['director-admin']!.signals[
      'cell.production-gce-c1.heartbeat_age_ms'
    ] = signal(9_000_000)

    expect(evaluateIncidentSample(sample, startedAt)).toMatchObject({
      status: 'green',
      failures: []
    })
  })

  it('freezes when cell power inventory is unavailable', () => {
    const sample = healthySample()
    sample.cells[0]!.runtimeKnown = false
    expect(evaluateIncidentSample(sample, startedAt).failures).toContainEqual({
      code: 'runtime_power_unknown',
      source: 'cloud-monitoring',
      signal: 'cell.production-gce-c1.powered'
    })
  })

  it('freezes on selector generation or tri-state membership drift', () => {
    const generation = healthySample()
    generation.selector = { ...generation.selector, generation: 2 }
    expect(evaluateIncidentSample(generation, startedAt).failures).toContainEqual(
      expect.objectContaining({ code: 'selector_mismatch' })
    )

    const membership = healthySample()
    membership.selector = {
      generation: 1,
      membership: {
        existingOnly: ['production-gce-c1'],
        migrationOnly: [],
        general: []
      }
    }
    expect(evaluateIncidentSample(membership, startedAt).failures).toContainEqual(
      expect.objectContaining({ code: 'selector_mismatch' })
    )
  })
})

describe('incident monitor lifecycle', () => {
  it('persists the exact 90-minute checkpoints while polling every minute', async () => {
    let now = startedAt
    const checkpoints: number[] = []
    const state = initialIncidentMonitorState({
      incidentId: 'incident-1',
      environment: 'production',
      expectedSelector: selector,
      preDrainDryRun: false,
      migrationPolicy: 'strict',
      recoverySourceCellId: null,
      capacityCellId: null,
      startedAt: new Date(startedAt).toISOString(),
      durationMinutes: 90,
      intervalMs: 60_000
    })
    const result = await runIncidentMonitor(state, {
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
      collect: async () => healthySample(now),
      persist: async () => {},
      checkpoint: async (summary) => {
        checkpoints.push(summary.checkpointMinute)
      }
    })
    expect(checkpoints).toEqual([...INCIDENT_CHECKPOINT_MINUTES])
    expect(result.sampleCount).toBe(91)
    expect(result.completedAt).not.toBeNull()
    expect(result.frozenAt).toBeNull()
  })

  it('latches monitor freeze across a restart without rewriting its time', async () => {
    let now = startedAt
    let unhealthy = true
    let persisted = initialIncidentMonitorState({
      incidentId: 'incident-1',
      environment: 'production',
      expectedSelector: selector,
      preDrainDryRun: false,
      migrationPolicy: 'strict',
      recoverySourceCellId: null,
      capacityCellId: null,
      startedAt: new Date(startedAt).toISOString(),
      durationMinutes: 15,
      intervalMs: 60_000
    })
    const stop = new Error('stop after first persistence')
    await expect(
      runIncidentMonitor(persisted, {
        now: () => now,
        wait: async () => {
          throw stop
        },
        collect: async () => {
          const sample = healthySample(now)
          if (unhealthy) {
            sample.sources['relay-logs']!.signals['relay.pool_waiting'] = signal(31, now)
          }
          return sample
        },
        persist: async (state) => {
          persisted = structuredClone(state)
        },
        checkpoint: async () => {}
      })
    ).rejects.toThrow('stop after first persistence')
    const frozenAt = persisted.frozenAt
    unhealthy = false
    now += 60_000
    const result = await runIncidentMonitor(persisted, {
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
      collect: async () => healthySample(now),
      persist: async () => {},
      checkpoint: async () => {}
    })
    expect(result.frozenAt).toBe(frozenAt)
    expect(preDrainDryRunPassed(result)).toBe(false)
  })

  it.each([15, 90])(
    'restarts a %i-minute continuous window after stale telemetry',
    async (durationMinutes) => {
      let now = startedAt
      let staleInjected = false
      const checkpoints: Array<[number, number]> = []
      const state = initialIncidentMonitorState({
        incidentId: 'incident-1',
        environment: 'production',
        expectedSelector: selector,
        preDrainDryRun: durationMinutes === 15,
        migrationPolicy: 'strict',
        recoverySourceCellId: null,
        capacityCellId: null,
        startedAt: new Date(startedAt).toISOString(),
        durationMinutes,
        intervalMs: 60_000
      })
      const result = await runIncidentMonitor(state, {
        now: () => now,
        wait: async (ms) => {
          now += ms
        },
        collect: async () => {
          if (!staleInjected && now === startedAt + 5 * 60_000) {
            staleInjected = true
            return healthySample(now - 180_001)
          }
          return healthySample(now)
        },
        persist: async () => {},
        checkpoint: async (summary) => {
          checkpoints.push([summary.windowSequence, summary.checkpointMinute])
        }
      })
      expect(result.windowSequence).toBe(1)
      expect(result.windowStartedAt).toBe(
        new Date(startedAt + 6 * 60_000).toISOString()
      )
      expect(result.completedAt).toBe(
        new Date(startedAt + (durationMinutes + 6) * 60_000).toISOString()
      )
      expect(result.sampleCount).toBe(durationMinutes + 1)
      expect(result.continuityEvents).toHaveLength(1)
      expect(result.continuityEvents[0]!.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'source_stale' })
        ])
      )
      expect(checkpoints).toContainEqual([1, durationMinutes])
      expect(result.frozenAt).toBeNull()
    }
  )

  it('resets at the next fresh sample after a runner gap', async () => {
    let now = startedAt + 10 * 60_000
    const state = {
      ...initialIncidentMonitorState({
        incidentId: 'incident-1',
        environment: 'production',
        expectedSelector: selector,
        preDrainDryRun: true,
        migrationPolicy: 'strict',
        recoverySourceCellId: null,
        capacityCellId: null,
        startedAt: new Date(startedAt).toISOString(),
        durationMinutes: 15,
        intervalMs: 60_000
      }),
      lastSampleAt: new Date(startedAt).toISOString(),
      sampleCount: 1,
      totalSampleCount: 1
    }
    const result = await runIncidentMonitor(state, {
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
      collect: async () => healthySample(now),
      persist: async () => {},
      checkpoint: async () => {}
    })
    expect(result.windowSequence).toBe(1)
    expect(result.windowStartedAt).toBe(new Date(startedAt + 10 * 60_000).toISOString())
    expect(result.continuityEvents[0]!.failures[0]!.code).toBe('monitor_gap')
    expect(result.sampleCount).toBe(16)
  })

  it('fails a dry run after 25 total minutes of continuity resets', async () => {
    let now = startedAt
    const state = initialIncidentMonitorState({
      incidentId: 'incident-1',
      environment: 'production',
      expectedSelector: selector,
      preDrainDryRun: true,
      migrationPolicy: 'strict',
      recoverySourceCellId: null,
      capacityCellId: null,
      startedAt: new Date(startedAt).toISOString(),
      durationMinutes: 15,
      intervalMs: 60_000
    })
    const result = await runIncidentMonitor(state, {
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
      collect: async () =>
        healthySample(now === startedAt + 10 * 60_000 ? now - 180_001 : now),
      persist: async () => {},
      checkpoint: async () => {}
    })

    expect(result.completedAt).toBe(
      new Date(startedAt + INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS).toISOString()
    )
    expect(result.frozenAt).not.toBeNull()
    expect(result.windowSequence).toBe(1)
    expect(result.sampleCount).toBe(15)
    expect(result.failures).toContainEqual({
      code: 'continuity_deadline_exceeded',
      source: 'active-probe',
      observed: INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS,
      threshold: INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS
    })
    expect(preDrainDryRunPassed(result)).toBe(false)
  })

  it('fails an overdue resumed dry run before collecting again', async () => {
    const now = startedAt + INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS + 1
    let collections = 0
    const state = initialIncidentMonitorState({
      incidentId: 'incident-1',
      environment: 'production',
      expectedSelector: selector,
      preDrainDryRun: true,
      migrationPolicy: 'strict',
      recoverySourceCellId: null,
      capacityCellId: null,
      startedAt: new Date(startedAt).toISOString(),
      durationMinutes: 15,
      intervalMs: 60_000
    })
    const result = await runIncidentMonitor(state, {
      now: () => now,
      wait: async () => {},
      collect: async () => {
        collections++
        return healthySample(now)
      },
      persist: async () => {},
      checkpoint: async () => {}
    })

    expect(collections).toBe(0)
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'continuity_deadline_exceeded'
    }))
  })

  it('requires a completed green 15-minute dry run', () => {
    const state = {
      ...initialIncidentMonitorState({
        incidentId: 'incident-1',
        environment: 'production',
        expectedSelector: selector,
        preDrainDryRun: true,
        migrationPolicy: 'strict',
        recoverySourceCellId: null,
        capacityCellId: null,
        startedAt: new Date(startedAt).toISOString(),
        durationMinutes: 15,
        intervalMs: 60_000
      }),
      sampleCount: 16,
      completedAt: new Date(startedAt + 15 * 60_000).toISOString()
    }
    expect(preDrainDryRunPassed(state)).toBe(true)
    expect(preDrainDryRunPassed({ ...state, frozenAt: state.startedAt })).toBe(false)
    expect(preDrainDryRunPassed({
      ...state,
      completedAt: new Date(startedAt + INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS + 1).toISOString()
    })).toBe(false)
  })

  it('keeps poll starts on the configured cadence after collection time', async () => {
    let now = startedAt
    const starts: number[] = []
    const waits: number[] = []
    const state = initialIncidentMonitorState({
      incidentId: 'incident-1',
      environment: 'production',
      expectedSelector: selector,
      preDrainDryRun: true,
      migrationPolicy: 'strict',
      recoverySourceCellId: null,
      capacityCellId: null,
      startedAt: new Date(startedAt).toISOString(),
      durationMinutes: 15,
      intervalMs: 60_000
    })
    await runIncidentMonitor(state, {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms)
        now += ms
      },
      collect: async () => {
        starts.push(now)
        now += 15_000
        return healthySample(now)
      },
      persist: async () => {},
      checkpoint: async () => {}
    })
    expect(starts.slice(0, 3)).toEqual([
      startedAt,
      startedAt + 60_000,
      startedAt + 120_000
    ])
    expect(waits[0]).toBe(45_000)
  })
})
