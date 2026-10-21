import { describe, expect, it } from 'vitest'
import {
  INCIDENT_FRESHNESS_TOLERANCE_SAMPLES,
  INCIDENT_MONITOR_THRESHOLDS,
  type IncidentSample
} from './incident-monitor.js'
import {
  attributeCellExits,
  evaluatePreDrainHardRules,
  PRE_DRAIN_HARD_RULES,
  PRE_DRAIN_MAX_OVERRUN_SAMPLES,
  preDrainSampleWindowMinutes,
  PreDrainSampleTripped,
  runPreDrainSample,
  type PreDrainHardRuleReadings
} from './pre-drain-sample.js'

const selector = {
  generation: 1,
  membership: { existingOnly: ['production-gce-c1'], migrationOnly: [], general: [] }
}

function greenSample(at: number): IncidentSample {
  const observedAt = new Date(at).toISOString()
  const signal = (value: number) => ({ value, observedAt })
  const source = (signals: Record<string, number>) => ({
    observedAt,
    signals: Object.fromEntries(
      Object.entries(signals).map(([name, value]) => [name, signal(value)])
    )
  })
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
      'active-probe': source({
        'director.health': 1,
        'director.ready': 1,
        'director.latency_ms': 1,
        'auth.health': 1,
        'auth.ready': 1,
        'auth.latency_ms': 1,
        'cell.production-gce-c1.health': 1,
        'cell.production-gce-c1.ready': 1,
        'cell.production-gce-c1.latency_ms': 1
      }),
      'cloud-monitoring': source({
        'cloud_sql.cpu': 0.1,
        'cloud_sql.memory': 0.1,
        'cloud_sql.backends': 1,
        'cloud_sql.lock_waits': 0,
        'cloud_sql.deadlocks': 0,
        'director.instances': 5,
        'director.cpu': 0.1,
        'director.memory': 0.1,
        'director.concurrency': 1,
        'director.errors': 0,
        'auth.errors': 0
      }),
      'relay-logs': source({
        'relay.pool_waiting': 0,
        'relay.pool_wait_ms': 0,
        'relay.postgres_retries': 0,
        'relay.postgres_retry_exhausted': 0,
        'cell.production-gce-c1.connections': 1,
        'cell.production-gce-c1.queued_bytes': 0
      }),
      'director-admin': source({
        'cell.production-gce-c1.admission_state': 0,
        'cell.production-gce-c1.heartbeat_fresh': 1,
        'cell.production-gce-c1.heartbeat_age_ms': 1,
        'cell.production-gce-c1.migration_blocked': 0,
        'cell.production-gce-c1.migration_target_inactive': 0
      })
    }
  }
}

const calm: PreDrainHardRuleReadings = {
  cellProcessExits: 0,
  unattributedExitInstances: [],
  director503PeakPerMinute: 40,
  directorConcurrencyP99: 20
}

// A fake clock the sampler's own waits advance, so a window runs in no real time.
function harness(input: {
  windowMinutes: number
  sampleAt?: (index: number, at: number) => IncidentSample | Error
  hardRulesAt?: (index: number) => PreDrainHardRuleReadings | Error
}) {
  let clock = Date.parse('2026-10-01T12:00:00.000Z')
  let samples = 0
  let reads = 0
  const run = runPreDrainSample({
    windowMinutes: input.windowMinutes,
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    collect: async () => {
      const result = input.sampleAt?.(samples, clock) ?? greenSample(clock)
      samples += 1
      if (result instanceof Error) throw result
      return result
    },
    readHardRules: async () => {
      const result = input.hardRulesAt?.(reads) ?? calm
      reads += 1
      if (result instanceof Error) throw result
      return result
    }
  })
  return { run, startedAt: clock, samples: () => samples }
}

describe('pre-drain sample window', () => {
  it('sizes the window to the hosts the drain will re-place', () => {
    expect(preDrainSampleWindowMinutes(0)).toBe(3)
    expect(preDrainSampleWindowMinutes(150)).toBe(3)
    expect(preDrainSampleWindowMinutes(500)).toBe(3)
    expect(preDrainSampleWindowMinutes(501)).toBe(5)
    expect(preDrainSampleWindowMinutes(1_500)).toBe(5)
    expect(preDrainSampleWindowMinutes(1_501)).toBe(8)
    expect(preDrainSampleWindowMinutes(2_750)).toBe(8)
  })

  it('refuses a host count it cannot size', () => {
    for (const hosts of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => preDrainSampleWindowMinutes(hosts)).toThrow('host count is invalid')
    }
  })
})

describe('cell exit attribution', () => {
  const scope = {
    targetCellId: 'production-gce-c25',
    placementCellIds: new Set(['production-gce-c25', 'production-gce-c26', 'production-gce-c17']),
    configuredCellIds: new Set([
      'production-gce-c5', 'production-gce-c17', 'production-gce-c25', 'production-gce-c26'
    ])
  }
  const attribute = (exits: Record<string, number>, cells: Record<string, string | null>) =>
    attributeCellExits({
      exitsByInstance: new Map(Object.entries(exits)),
      cellByInstance: new Map(Object.entries(cells)),
      ...scope
    })

  it('ignores the target cell rolling the fix for its own crashes', () => {
    expect(attribute({ '25': 12 }, { '25': 'production-gce-c25' }))
      .toEqual({ counted: 0, unattributed: [] })
  })

  it('counts an exit on another general or migration-only cell', () => {
    expect(attribute({ '26': 1 }, { '26': 'production-gce-c26' }))
      .toEqual({ counted: 1, unattributed: [] })
    expect(attribute({ '17': 2 }, { '17': 'production-gce-c17' }))
      .toEqual({ counted: 2, unattributed: [] })
  })

  it('ignores an existing-only legacy cell, which takes no placements', () => {
    expect(attribute({ '5': 15 }, { '5': 'production-gce-c5' }))
      .toEqual({ counted: 0, unattributed: [] })
  })

  it('reports an instance with no cell, or an unknown cell, as unattributed', () => {
    expect(attribute({ '9': 1, '8': 1 }, { '9': null, '8': 'production-gce-c99' }))
      .toEqual({ counted: 0, unattributed: ['8', '9'] })
    expect(attribute({ '7': 1 }, {})).toEqual({ counted: 0, unattributed: ['7'] })
  })

  it('trips the rule through the evaluator for a counted exit', () => {
    const { counted } = attribute({ '26': 1, '25': 3, '5': 4 }, {
      '26': 'production-gce-c26', '25': 'production-gce-c25', '5': 'production-gce-c5'
    })
    expect(evaluatePreDrainHardRules({ ...calm, cellProcessExits: counted })).toEqual([
      expect.objectContaining({ signal: 'cells.process_exits_10m', observed: 1 })
    ])
  })
})

describe('pre-drain hard rules', () => {
  it('passes a calm fleet', () => {
    expect(evaluatePreDrainHardRules(calm)).toEqual([])
  })

  it('trips on any cell container exit in the lookback', () => {
    expect(evaluatePreDrainHardRules({ ...calm, cellProcessExits: 1 })).toEqual([
      expect.objectContaining({ signal: 'cells.process_exits_10m', observed: 1, threshold: 0 })
    ])
  })

  it('trips on an exit no cell could be named for', () => {
    expect(evaluatePreDrainHardRules({ ...calm, unattributedExitInstances: ['111', '222'] }))
      .toEqual([expect.objectContaining({
        code: 'exit_unattributed',
        signal: 'cells.process_exits_10m.instances=111+222',
        observed: 2
      })])
  })

  it('trips on a disconnect pulse, not on a busy healthy minute', () => {
    expect(evaluatePreDrainHardRules({ ...calm, director503PeakPerMinute: 500 })).toEqual([])
    expect(evaluatePreDrainHardRules({ ...calm, director503PeakPerMinute: 501 })).toEqual([
      expect.objectContaining({ signal: 'director.503_peak_minute_10m', observed: 501 })
    ])
  })

  it('holds director concurrency p99 to the monitor threshold', () => {
    expect(PRE_DRAIN_HARD_RULES.directorConcurrencyP99Max)
      .toBe(INCIDENT_MONITOR_THRESHOLDS.directorConcurrency)
    const max = PRE_DRAIN_HARD_RULES.directorConcurrencyP99Max
    expect(evaluatePreDrainHardRules({ ...calm, directorConcurrencyP99: max })).toEqual([])
    // The 2026-10-01 13:42Z refusal.
    expect(evaluatePreDrainHardRules({ ...calm, directorConcurrencyP99: 66.8 })).toEqual([
      expect.objectContaining({ code: 'threshold_max', signal: 'director.concurrency_p99_4m' })
    ])
  })

  it('reads an unpublished concurrency series as missing, never as calm', () => {
    expect(evaluatePreDrainHardRules({ ...calm, directorConcurrencyP99: null })).toEqual([
      expect.objectContaining({ code: 'signal_missing', signal: 'director.concurrency_p99_4m' })
    ])
  })
})

describe('runPreDrainSample', () => {
  it('passes after one sample per minute across the whole window', async () => {
    for (const windowMinutes of [3, 5, 8]) {
      const { run, startedAt, samples } = harness({ windowMinutes })
      const result = await run
      expect(samples()).toBe(windowMinutes + 1)
      expect(Date.parse(result.completedAt) - startedAt).toBeGreaterThanOrEqual(
        windowMinutes * 60_000
      )
    }
  })

  it('refuses a window that is not one of the sized bands', async () => {
    await expect(harness({ windowMinutes: 15 }).run).rejects.toThrow('window is invalid')
  })

  it('trips at once on a hard rule, before the window ends', async () => {
    const { run, samples } = harness({
      windowMinutes: 8,
      hardRulesAt: (index) => (index === 2 ? { ...calm, cellProcessExits: 1 } : calm)
    })
    await expect(run).rejects.toBeInstanceOf(PreDrainSampleTripped)
    await expect(run).rejects.toThrow('cells.process_exits_10m')
    expect(samples()).toBe(3)
  })

  it('trips at once on a monitor threshold the monitor never tolerates', async () => {
    const { run } = harness({
      windowMinutes: 3,
      sampleAt: (index, at) => {
        const next = greenSample(at)
        if (index === 1) {
          next.sources['cloud-monitoring']!.signals['director.concurrency'] = {
            value: 80,
            observedAt: new Date(at).toISOString()
          }
        }
        return next
      }
    })
    await expect(run).rejects.toThrow('director.concurrency observed=80')
  })

  it('rides out a cell probe within the monitor tolerance and trips past it', async () => {
    const failingProbe = (failFor: number) => (index: number, at: number) => {
      const next = greenSample(at)
      if (index >= 1 && index < 1 + failFor) {
        next.sources['active-probe']!.signals['cell.production-gce-c1.health'] = {
          value: 0,
          observedAt: new Date(at).toISOString()
        }
      }
      return next
    }
    const tolerance = INCIDENT_MONITOR_THRESHOLDS.cellProbeToleranceSamples
    await expect(
      harness({ windowMinutes: 3, sampleAt: failingProbe(tolerance) }).run
    ).resolves.toBeDefined()
    await expect(
      harness({ windowMinutes: 3, sampleAt: failingProbe(tolerance + 1) }).run
    ).rejects.toThrow('cell.production-gce-c1.health')
  })

  it('rides out failed reads within the freshness tolerance and trips past it', async () => {
    const failingReads = (failFor: number) => (index: number) =>
      index >= 1 && index < 1 + failFor ? new Error('Cloud Monitoring returned 503') : calm
    await expect(
      harness({
        windowMinutes: 3,
        hardRulesAt: failingReads(INCIDENT_FRESHNESS_TOLERANCE_SAMPLES)
      }).run
    ).resolves.toBeDefined()
    await expect(
      harness({
        windowMinutes: 3,
        hardRulesAt: failingReads(INCIDENT_FRESHNESS_TOLERANCE_SAMPLES + 1)
      }).run
    ).rejects.toThrow('collector_failed pre-drain.hard-rules')
  })

  // Why: the drain starts right after this returns, so it must not start on a reading the
  // tolerance was still carrying.
  it('keeps sampling past the window until a sample is clean', async () => {
    const { run, samples } = harness({
      windowMinutes: 3,
      hardRulesAt: (index) => (index === 3 ? { ...calm, directorConcurrencyP99: null } : calm)
    })
    const result = await run
    expect(samples()).toBe(5)
    expect(result.samples.at(-1)?.failures).toEqual([])
  })

  // Why: two tolerated readings that alternate never build a streak, so only the overrun cap
  // stops them from holding the step open until its timeout.
  it('trips when alternating tolerated readings never leave a clean sample', async () => {
    const { run, samples } = harness({
      windowMinutes: 3,
      hardRulesAt: (index) =>
        index >= 3 && index % 2 === 1 ? { ...calm, directorConcurrencyP99: null } : calm,
      sampleAt: (index, at) =>
        index >= 3 && index % 2 === 0 ? new Error('collector down') : greenSample(at)
    })
    await expect(run).rejects.toBeInstanceOf(PreDrainSampleTripped)
    expect(samples()).toBe(4 + PRE_DRAIN_MAX_OVERRUN_SAMPLES)
  })

  it('records why a read failed', async () => {
    const records: string[][] = []
    let clock = 0
    await runPreDrainSample({
      windowMinutes: 3,
      now: () => clock,
      wait: async (ms) => { clock += ms },
      collect: async () => greenSample(clock),
      readHardRules: async () => {
        if (records.length === 1) throw new Error('Google telemetry returned 403')
        return calm
      },
      log: (record) => records.push(record.errors)
    })
    expect(records[1]).toEqual(['hard rules: Google telemetry returned 403'])
  })
})
