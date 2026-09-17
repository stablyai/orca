import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  livePreflightGcloud,
  runIncidentLivePreflight
} from './incident-live-preflight-cli.js'
import {
  INCIDENT_MONITOR_THRESHOLDS,
  type IncidentSample
} from './incident-monitor.js'
import { relayOpsEnvironment } from './environment-config.js'
import type { AdmissionSelector } from './incident-selector.js'

const directories: string[] = []
const now = Date.parse('2026-07-28T12:00:00.000Z')
const selector = {
  generation: 1,
  membership: {
    existingOnly: ['production-gce-c1'],
    migrationOnly: [],
    general: []
  }
}

function stateFile(
  migrationPolicy: 'strict' | 'recover-forward' | 'capacity-transition' = 'strict',
  overrides: Record<string, unknown> = {}
): string {
  const directory = mkdtempSync(join(tmpdir(), 'relay-live-preflight-'))
  directories.push(directory)
  const path = join(directory, 'state.json')
  const expectedSelector = migrationPolicy === 'capacity-transition'
    ? {
        generation: 1,
        membership: {
          existingOnly: [],
          migrationOnly: [],
          general: ['production-gce-c1']
        }
      }
    : selector
  writeFileSync(path, JSON.stringify({
    schemaVersion: 4,
    environment: 'production',
    expectedSelector,
    migrationPolicy,
    recoverySourceCellId:
      migrationPolicy === 'recover-forward' ? 'production-gce-c1' : null,
    capacityCellId:
      migrationPolicy === 'capacity-transition' ? 'production-gce-c1' : null,
    preDrainDryRun: true,
    startedAt: new Date(now - 17 * 60_000).toISOString(),
    windowStartedAt: new Date(now - 16 * 60_000).toISOString(),
    durationMinutes: 15,
    intervalMs: 60_000,
    sampleCount: 16,
    lastSampleAt: new Date(now - 60_007).toISOString(),
    frozenAt: null,
    completedAt: new Date(now - 60_000).toISOString(),
    ...overrides
  }))
  return path
}

// Every configured production cell, in the lexicographic order
// normalizeSelectorMembership canonicalises to. Derived from the same durable
// Terraform config the override path reads, so a new cell cannot strand these.
const configuredCellIds = relayOpsEnvironment('production').cells.map(
  (cell) => cell.cellId
)
const canonicalCellIds = [...configuredCellIds].sort()
const canonicalMembership = {
  existingOnly: canonicalCellIds,
  migrationOnly: [],
  general: []
}

// What the director reports: a normalised selector, never an echo of what the
// caller expected. An order-sensitive comparison only holds if the override path
// canonicalises its own input the same way.
function canonicalSample(generation = 1): IncidentSample {
  const next = sample()
  next.selector = { generation, membership: canonicalMembership }
  return next
}

function membershipFile(
  membership: Record<string, string[]> = canonicalMembership
): string {
  const directory = mkdtempSync(join(tmpdir(), 'relay-live-preflight-selector-'))
  directories.push(directory)
  const path = join(directory, 'selector.json')
  writeFileSync(path, JSON.stringify(membership))
  return path
}

function sample(): IncidentSample {
  const observedAt = new Date(now).toISOString()
  const signal = (value: number) => ({ value, observedAt })
  return {
    collectedAt: observedAt,
    selector,
    expectedSelector: selector,
    cells: [{
      cellId: 'production-gce-c1',
      region: 'us-central1',
      runtimeKnown: true,
      powered: true,
      expectedAdmissionState: 'existing-only'
    }],
    sources: {
      'active-probe': {
        observedAt,
        signals: {
          'director.health': signal(1),
          'director.ready': signal(1),
          'director.latency_ms': signal(1),
          'auth.health': signal(1),
          'auth.ready': signal(1),
          'auth.latency_ms': signal(1),
          'cell.production-gce-c1.health': signal(1),
          'cell.production-gce-c1.ready': signal(1),
          'cell.production-gce-c1.latency_ms': signal(1)
        }
      },
      'cloud-monitoring': {
        observedAt,
        signals: {
          'cloud_sql.cpu': signal(0.1),
          'cloud_sql.memory': signal(0.1),
          'cloud_sql.backends': signal(1),
          'cloud_sql.lock_waits': signal(0),
          'cloud_sql.deadlocks': signal(0),
          'director.instances': signal(5),
          'director.cpu': signal(0.1),
          'director.memory': signal(0.1),
          'director.concurrency': signal(1),
          'director.errors': signal(0),
          'auth.errors': signal(0)
        }
      },
      'relay-logs': {
        observedAt,
        signals: {
          'relay.pool_waiting': signal(0),
          'relay.pool_wait_ms': signal(0),
          'relay.postgres_retries': signal(0),
          'relay.postgres_retry_exhausted': signal(0),
          'cell.production-gce-c1.connections': signal(1),
          'cell.production-gce-c1.queued_bytes': signal(0)
        }
      },
      'director-admin': {
        observedAt,
        signals: {
          'cell.production-gce-c1.admission_state': signal(0),
          'cell.production-gce-c1.heartbeat_fresh': signal(1),
          'cell.production-gce-c1.heartbeat_age_ms': signal(1),
          'cell.production-gce-c1.migration_blocked': signal(0),
          'cell.production-gce-c1.migration_target_inactive': signal(0)
        }
      }
    }
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('relay incident live preflight', () => {
  it('accepts the package-manager argument separator', async () => {
    await expect(runIncidentLivePreflight(
      ['--', '--state-file', stateFile()],
      { now: () => now, collect: async () => sample() }
    )).resolves.toBeUndefined()
  })

  it('accepts one complete fresh green sample', async () => {
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: async () => sample() }
    )).resolves.toBeUndefined()
  })

  it('rejects monitor evidence beyond the 35-minute lineage bound', async () => {
    const path = stateFile('strict', {
      startedAt: new Date(now - 36 * 60_000 - 1).toISOString()
    })
    await expect(runIncidentLivePreflight(
      ['--state-file', path],
      { now: () => now, collect: async () => sample() }
    )).rejects.toThrow('monitor evidence is incomplete or stale')
  })

  it('scales the evidence age bound by same-cap wave index', async () => {
    const agedState = (ageMs: number) => stateFile('strict', {
      startedAt: new Date(now - ageMs - 17 * 60_000).toISOString(),
      windowStartedAt: new Date(now - ageMs - 16 * 60_000).toISOString(),
      lastSampleAt: new Date(now - ageMs - 7).toISOString(),
      completedAt: new Date(now - ageMs).toISOString()
    })
    const deps = { now: () => now, collect: async () => sample() }
    // One predecessor cell roll (~16 min) exceeds wave 0 but fits wave 1.
    const oneRollOld = agedState(17 * 60_000)
    await expect(runIncidentLivePreflight(
      ['--state-file', oneRollOld], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    await expect(runIncidentLivePreflight(
      ['--state-file', oneRollOld, '--wave-index', '0'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    await expect(runIncidentLivePreflight(
      ['--state-file', oneRollOld, '--wave-index', '1'], deps
    )).resolves.toBeUndefined()
    // Wave 0 edges: the 10-minute bound covers same-cap job start-up latency.
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(10 * 60_000), '--wave-index', '0'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(10 * 60_000 + 1), '--wave-index', '0'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    // Both edges of one predecessor job timeout: 10min + 75min exactly.
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(85 * 60_000), '--wave-index', '1'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(85 * 60_000 + 1), '--wave-index', '1'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(160 * 60_000), '--wave-index', '2'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(160 * 60_000 + 1), '--wave-index', '2'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(235 * 60_000), '--wave-index', '3'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(235 * 60_000 + 1), '--wave-index', '3'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    // The wave index is a strict single-use 0-3 argument.
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--wave-index', '4'], deps
    )).rejects.toThrow('usage:')
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--wave-index', ''], deps
    )).rejects.toThrow('usage:')
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--wave-index', '1', '--wave-index', '1'],
      deps
    )).rejects.toThrow('usage:')
  })

  it('expects the wave-adjusted live selector generation', async () => {
    const agedPath = stateFile('strict', {
      startedAt: new Date(now - 34 * 60_000).toISOString(),
      windowStartedAt: new Date(now - 33 * 60_000).toISOString(),
      lastSampleAt: new Date(now - 17 * 60_000 - 7).toISOString(),
      completedAt: new Date(now - 17 * 60_000).toISOString()
    })
    const liveAt = (generation: number) =>
      async (expectedSelector: AdmissionSelector) => ({
        ...sample(),
        selector: { ...selector, generation },
        expectedSelector
      })
    // One predecessor roll advanced the live selector by exactly 2.
    await expect(runIncidentLivePreflight(
      ['--state-file', agedPath, '--wave-index', '1'],
      { now: () => now, collect: liveAt(selector.generation + 2) }
    )).resolves.toBeUndefined()
    // The sealed pre-roll generation must no longer satisfy wave 1.
    await expect(runIncidentLivePreflight(
      ['--state-file', agedPath, '--wave-index', '1'],
      { now: () => now, collect: liveAt(selector.generation) }
    )).rejects.toThrow('director-admin/selector_mismatch')
    // Wave 0 still expects the sealed generation itself.
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: liveAt(selector.generation) }
    )).resolves.toBeUndefined()
  })

  it('fails closed on a live threshold breach', async () => {
    const unhealthy = sample()
    unhealthy.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.value = 0.9
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: async () => unhealthy }
    )).rejects.toThrow('cloud-monitoring/threshold_max')
  })

  // Why: a frozen wave has to name what froze it without re-reading the sample.
  it('names the signal and its numbers in the failure message', async () => {
    const slowCell = sample()
    slowCell.sources['active-probe']!.signals[
      'cell.production-gce-c1.latency_ms'
    ]!.value = 2_568
    // A cell probe now re-samples before it fails a wave, so the wait is injected;
    // this cell stays slow on every sample and still names what stopped it.
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: async () => slowCell, wait: async () => {} }
    )).rejects.toThrow(
      'relay live preflight failed: active-probe/threshold_max cell.production-gce-c1.latency_ms observed=2568 threshold=2000'
    )

    // A failure with no signal keeps the source/code token and drops the rest.
    const stale = sample()
    stale.sources['active-probe']!.observedAt = new Date(now - 60_001).toISOString()
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: async () => stale }
    )).rejects.toThrow(
      'relay live preflight failed: active-probe/source_stale observed=60001 threshold=60000'
    )
  })

  // Why: this one sample decides a mutating wave, so an Asia cell's ~30 s
  // "no healthy upstream" window could still fail a wave here even after the
  // 15-minute gate learned to ride it out.
  describe('cell probe tolerance', () => {
    const tolerance = INCIDENT_MONITOR_THRESHOLDS.cellProbeToleranceSamples

    // Serves `badSamples` unhealthy cell readings, then healthy ones.
    const downThen = (badSamples: number) => {
      let index = 0
      return async () => {
        const next = sample()
        if (index++ < badSamples) {
          next.sources['active-probe']!.signals['cell.production-gce-c1.health']!
            .value = 0
          next.sources['active-probe']!.signals['cell.production-gce-c1.ready']!
            .value = 0
        }
        return next
      }
    }

    it('re-samples through a probe outage within the tolerance', async () => {
      const waits: number[] = []
      await expect(runIncidentLivePreflight(
        ['--state-file', stateFile()],
        {
          now: () => now,
          collect: downThen(tolerance),
          wait: async (ms) => {
            waits.push(ms)
          }
        }
      )).resolves.toBeUndefined()
      expect(waits).toHaveLength(tolerance)
    })

    it('fails the wave once the probe outage outlasts the tolerance', async () => {
      await expect(runIncidentLivePreflight(
        ['--state-file', stateFile()],
        {
          now: () => now,
          collect: downThen(tolerance + 1),
          wait: async () => {}
        }
      )).rejects.toThrow('active-probe/threshold_equal cell.production-gce-c1.health')
    })

    it('does not re-sample a director probe failure', async () => {
      let samples = 0
      const down = async () => {
        samples++
        const next = sample()
        next.sources['active-probe']!.signals['director.health']!.value = 0
        return next
      }
      await expect(runIncidentLivePreflight(
        ['--state-file', stateFile()],
        { now: () => now, collect: down, wait: async () => {} }
      )).rejects.toThrow('active-probe/threshold_equal director.health')
      expect(samples).toBe(1)
    })

    it('does not re-sample a non-probe threshold failure', async () => {
      let samples = 0
      const hot = async () => {
        samples++
        const next = sample()
        next.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.value = 0.9
        return next
      }
      await expect(runIncidentLivePreflight(
        ['--state-file', stateFile()],
        { now: () => now, collect: hot, wait: async () => {} }
      )).rejects.toThrow('cloud-monitoring/threshold_max')
      expect(samples).toBe(1)
    })
  })

  // Why: on 2026-09-17 a canary wave died because one director admin read
  // returned 404 for a 2 s Cloud SQL pool timeout. Collecting the sample is not
  // a health verdict, so a thrown collector spends an attempt instead.
  describe('collector failures', () => {
    it('re-samples after a thrown collector and then passes', async () => {
      const waits: number[] = []
      let attempts = 0
      await expect(runIncidentLivePreflight(
        ['--state-file', stateFile()],
        {
          now: () => now,
          collect: async () => {
            attempts++
            if (attempts === 1) throw new Error('Relay admin telemetry returned 404')
            return sample()
          },
          wait: async (ms) => {
            waits.push(ms)
          }
        }
      )).resolves.toBeUndefined()
      expect(attempts).toBe(2)
      expect(waits).toEqual([15_000])
    })

    it('fails the wave when every attempt throws, naming the collector', async () => {
      let attempts = 0
      await expect(runIncidentLivePreflight(
        ['--state-file', stateFile()],
        {
          now: () => now,
          collect: async () => {
            attempts++
            throw new Error('Relay admin telemetry returned 404')
          },
          wait: async () => {}
        }
      )).rejects.toThrow(
        'relay live preflight failed: collector: Relay admin telemetry returned 404'
      )
      expect(attempts).toBe(1 + INCIDENT_MONITOR_THRESHOLDS.cellProbeToleranceSamples)
    })

    it('does not re-sample a collector failure past the evidence-age budget', async () => {
      const agedPath = stateFile('strict', {
        startedAt: new Date(now - 26 * 60_000).toISOString(),
        windowStartedAt: new Date(now - 25 * 60_000).toISOString(),
        lastSampleAt: new Date(now - 10 * 60_000 + 7).toISOString(),
        completedAt: new Date(now - 10 * 60_000 + 14).toISOString()
      })
      let attempts = 0
      await expect(runIncidentLivePreflight(
        ['--state-file', agedPath],
        {
          now: () => now,
          collect: async () => {
            attempts++
            throw new Error('Relay admin telemetry returned 404')
          },
          wait: async () => {}
        }
      )).rejects.toThrow('relay live preflight failed: collector:')
      expect(attempts).toBe(1)
    })
  })

  it('enforces the signed migration policy', async () => {
    const inactiveTarget = sample()
    inactiveTarget.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_target_inactive'
    ]!.value = 30
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: async () => inactiveTarget }
    )).rejects.toThrow('director-admin/threshold_max')
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile('recover-forward')],
      { now: () => now, collect: async () => inactiveTarget }
    )).resolves.toBeUndefined()
    inactiveTarget.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_blocked'
    ]!.value = 1
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile('recover-forward')],
      { now: () => now, collect: async () => inactiveTarget }
    )).rejects.toThrow('director-admin/threshold_max')
  })

  it('binds capacity-transition evidence to its general cell', async () => {
    const capacitySample = sample()
    const capacitySelector = {
      generation: 1,
      membership: {
        existingOnly: [],
        migrationOnly: [],
        general: ['production-gce-c1']
      }
    }
    capacitySample.selector = capacitySelector
    capacitySample.expectedSelector = capacitySelector
    capacitySample.cells[0]!.expectedAdmissionState = 'general'
    capacitySample.sources['director-admin']!.signals[
      'cell.production-gce-c1.admission_state'
    ]!.value = 2
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile('capacity-transition')],
      { now: () => now, collect: async () => capacitySample }
    )).resolves.toBeUndefined()
    capacitySample.sources['director-admin']!.signals[
      'cell.production-gce-c1.migration_target_inactive'
    ]!.value = 1
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile('capacity-transition')],
      { now: () => now, collect: async () => capacitySample }
    )).rejects.toThrow('director-admin/threshold_max')
  })

  it('rejects stale live evidence', async () => {
    const stale = sample()
    stale.sources['active-probe']!.observedAt = new Date(now - 60_001).toISOString()
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile()],
      { now: () => now, collect: async () => stale }
    )).rejects.toThrow('active-probe/source_stale')
  })

  it('retries freshness-only failures when explicitly requested', async () => {
    const stale = sample()
    stale.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.observedAt =
      new Date(now - (INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs + 1)).toISOString()
    const missing = sample()
    delete missing.sources['relay-logs']
    const collect = vi.fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(sample())
    const wait = vi.fn(async () => undefined)
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--retry-freshness'],
      { now: () => now, collect, wait }
    )).resolves.toBeUndefined()
    expect(collect).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 15_000)
    expect(wait).toHaveBeenNthCalledWith(2, 15_000)
  })

  it('retries a first-wave stale sample and passes on the fresh one', async () => {
    const stale = sample()
    stale.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.observedAt =
      new Date(now - (INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs + 1)).toISOString()
    const collect = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(sample())
    const wait = vi.fn(async () => undefined)
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--wave-index', '0', '--retry-freshness'],
      { now: () => now, collect, wait }
    )).resolves.toBeUndefined()
    expect(collect).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledOnce()
  })

  it('stops retrying when the next wait would exceed the evidence-age bound', async () => {
    const completedAt = now - 590_000
    const stale = sample()
    stale.sources['cloud-monitoring']!.observedAt = new Date(now - (INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs + 1)).toISOString()
    const collect = vi.fn(async () => stale)
    const wait = vi.fn(async () => undefined)
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile('strict', {
        startedAt: new Date(completedAt - 17 * 60_000).toISOString(),
        windowStartedAt: new Date(completedAt - 16 * 60_000).toISOString(),
        lastSampleAt: new Date(completedAt - 30_000).toISOString(),
        completedAt: new Date(completedAt).toISOString()
      }), '--retry-freshness'],
      { now: () => now, collect, wait }
    )).rejects.toThrow('cloud-monitoring/source_stale')
    expect(collect).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })

  it('does not retry a threshold failure', async () => {
    const unhealthy = sample()
    unhealthy.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.value = 0.9
    unhealthy.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.observedAt =
      new Date(now - (INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs + 1)).toISOString()
    const collect = vi.fn(async () => unhealthy)
    const wait = vi.fn(async () => undefined)
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--retry-freshness'],
      { now: () => now, collect, wait }
    )).rejects.toThrow('cloud-monitoring/threshold_max')
    expect(collect).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })

  it('fails closed after the bounded freshness retry window', async () => {
    const stale = sample()
    stale.sources['cloud-monitoring']!.observedAt = new Date(now - (INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs + 1)).toISOString()
    const collect = vi.fn(async () => stale)
    const wait = vi.fn(async () => undefined)
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--retry-freshness'],
      { now: () => now, collect, wait }
    )).rejects.toThrow('cloud-monitoring/source_stale')
    expect(collect).toHaveBeenCalledTimes(5)
    expect(wait).toHaveBeenCalledTimes(4)
  })


  // Why: the same-cap break-glass skips the sealed 15-minute aggregate evidence,
  // so this live recheck is the only thing left standing between the dispatch and
  // a mutation. It must judge the fleet exactly as it does with evidence, and it
  // must never accept a half-specified override.
  describe('break-glass without monitor state', () => {
    const overrideArgs = (extra: string[] = [], membership = canonicalMembership) => [
      '--no-monitor-state',
      '--expected-selector-generation', '1',
      '--selector-membership-file', membershipFile(membership),
      ...extra
    ]

    // The director's reading, plus whatever the override path decided to expect.
    const liveCollect = (
      mutate: (next: IncidentSample) => IncidentSample = (next) => next
    ) => async (expected: AdmissionSelector) => {
      const next = canonicalSample(expected.generation)
      next.expectedSelector = expected
      return mutate(next)
    }

    it('accepts one complete fresh green sample with no sealed evidence', async () => {
      await expect(runIncidentLivePreflight(
        overrideArgs(),
        { now: () => now, collect: liveCollect() }
      )).resolves.toBeUndefined()
    })

    // Why: the live selector is normalised and the comparison is an ordered
    // stringify, so an operator's unsorted membership must canonicalise here or
    // every override wave reads as selector drift on a healthy fleet.
    it('canonicalises an unsorted operator membership', async () => {
      const shuffled = {
        existingOnly: [...canonicalCellIds].reverse(),
        migrationOnly: [],
        general: []
      }
      expect(shuffled.existingOnly).not.toEqual(canonicalCellIds)
      const seen: AdmissionSelector[] = []
      await expect(runIncidentLivePreflight(
        overrideArgs([], shuffled),
        {
          now: () => now,
          collect: async (expected) => {
            seen.push(expected)
            const next = canonicalSample(expected.generation)
            next.expectedSelector = expected
            return next
          }
        }
      )).resolves.toBeUndefined()
      expect(seen[0]!.membership.existingOnly).toEqual(canonicalCellIds)
    })

    // Why: normalising is also what enforces every configured cell exactly once,
    // which a bare schema parse would have dropped.
    it('rejects a membership that is not every configured cell exactly once', async () => {
      const duplicated = {
        existingOnly: [...canonicalCellIds, canonicalCellIds[0] as string],
        migrationOnly: [],
        general: []
      }
      await expect(runIncidentLivePreflight(
        overrideArgs([], duplicated),
        { now: () => now, collect: liveCollect() }
      )).rejects.toThrow('every configured cell exactly once')
      const missing = {
        existingOnly: canonicalCellIds.slice(1),
        migrationOnly: [],
        general: []
      }
      await expect(runIncidentLivePreflight(
        overrideArgs([], missing),
        { now: () => now, collect: liveCollect() }
      )).rejects.toThrow('every configured cell exactly once')
      const unknown = {
        existingOnly: [...canonicalCellIds.slice(1), 'production-gce-c999'],
        migrationOnly: [],
        general: []
      }
      await expect(runIncidentLivePreflight(
        overrideArgs([], unknown),
        { now: () => now, collect: liveCollect() }
      )).rejects.toThrow('every configured cell exactly once')
    })

    it('fails closed on a live threshold breach', async () => {
      await expect(runIncidentLivePreflight(
        overrideArgs(),
        {
          now: () => now,
          collect: liveCollect((next) => {
            next.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.value = 0.99
            return next
          }),
          wait: async () => {}
        }
      )).rejects.toThrow('cloud-monitoring/threshold_max cloud_sql.cpu')
    })

    it('fails closed on a live selector mismatch', async () => {
      await expect(runIncidentLivePreflight(
        overrideArgs(),
        {
          now: () => now,
          collect: liveCollect((next) => {
            next.selector = { ...next.selector, generation: 7 }
            return next
          }),
          wait: async () => {}
        }
      )).rejects.toThrow('selector_mismatch')
    })

    it('expects the wave-adjusted live selector generation', async () => {
      const seen: AdmissionSelector[] = []
      await expect(runIncidentLivePreflight(
        overrideArgs(['--wave-index', '2']),
        {
          now: () => now,
          collect: async (expected) => {
            seen.push(expected)
            const next = canonicalSample(expected.generation)
            next.expectedSelector = expected
            return next
          }
        }
      )).resolves.toBeUndefined()
      expect(seen[0]!.generation).toBe(5)
    })

    it('pins the strictest migration policy', async () => {
      // An inactive migration target is tolerable only under recover-forward,
      // and an override cannot elect that policy, so this must still fail.
      await expect(runIncidentLivePreflight(
        overrideArgs(),
        {
          now: () => now,
          collect: liveCollect((next) => {
            next.sources['director-admin']!.signals[
              'cell.production-gce-c1.migration_target_inactive'
            ]!.value = 30
            return next
          }),
          wait: async () => {}
        }
      )).rejects.toThrow('director-admin/threshold_max')
    })

    it('rejects a half-specified override', async () => {
      const cases: string[][] = [
        ['--no-monitor-state'],
        ['--no-monitor-state', '--expected-selector-generation', '1'],
        ['--no-monitor-state', '--selector-membership-file', membershipFile()],
        // Mixing the two sources would let a caller pass sealed evidence it
        // never wants read.
        [
          '--no-monitor-state',
          '--expected-selector-generation', '1',
          '--selector-membership-file', membershipFile(),
          '--state-file', stateFile()
        ],
        // Override arguments without the flag must not be silently ignored.
        ['--state-file', stateFile(), '--expected-selector-generation', '1'],
        ['--no-monitor-state', '--no-monitor-state'],
        ['--expected-selector-generation', '1']
      ]
      for (const args of cases) {
        await expect(runIncidentLivePreflight(
          args,
          { now: () => now, collect: liveCollect() }
        )).rejects.toThrow('usage:')
      }
    })

    it('rejects an unknown option and a negative generation', async () => {
      await expect(runIncidentLivePreflight(
        overrideArgs(['--skip-everything']),
        { now: () => now, collect: liveCollect() }
      )).rejects.toThrow('usage:')
      await expect(runIncidentLivePreflight(
        [
          '--no-monitor-state',
          '--expected-selector-generation', '-1',
          '--selector-membership-file', membershipFile()
        ],
        { now: () => now, collect: liveCollect() }
      )).rejects.toThrow()
    })

    it('re-samples a tolerable failure and then passes', async () => {
      let samples = 0
      await expect(runIncidentLivePreflight(
        overrideArgs(),
        {
          now: () => now,
          collect: liveCollect((next) => {
            samples++
            if (samples === 1) {
              next.sources['cloud-monitoring']!.signals['director.instances']!.value = 2
            }
            return next
          }),
          wait: async () => {}
        }
      )).resolves.toBeUndefined()
      expect(samples).toBe(2)
    })
  })

  it('uses the supplied admin token without minting through gcloud', async () => {
    const identityToken = vi.fn(async () => 'minted.token.value')
    const gcloud = livePreflightGcloud(
      { accessToken: async () => 'access-token', identityToken },
      { ORCA_RELAY_ADMIN_ID_TOKEN: 'supplied.token.value' }
    )
    await expect(gcloud.identityToken!('audience')).resolves.toBe(
      'supplied.token.value'
    )
    expect(identityToken).not.toHaveBeenCalled()
  })
})
