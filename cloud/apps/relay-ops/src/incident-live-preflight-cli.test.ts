import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  livePreflightGcloud,
  runIncidentLivePreflight
} from './incident-live-preflight-cli.js'
import type { IncidentSample } from './incident-monitor.js'
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

function sample(): IncidentSample {
  const observedAt = new Date(now).toISOString()
  const signal = (value: number) => ({ value, observedAt })
  return {
    collectedAt: observedAt,
    selector,
    expectedSelector: selector,
    cells: [{
      cellId: 'production-gce-c1',
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

  it('rejects monitor evidence beyond the 25-minute lineage bound', async () => {
    const path = stateFile('strict', {
      startedAt: new Date(now - 26 * 60_000 - 1).toISOString()
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
    // Both edges of one predecessor job timeout: 5min + 75min exactly.
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(80 * 60_000), '--wave-index', '1'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(80 * 60_000 + 1), '--wave-index', '1'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(155 * 60_000), '--wave-index', '2'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(155 * 60_000 + 1), '--wave-index', '2'], deps
    )).rejects.toThrow('monitor evidence is incomplete or stale')
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(230 * 60_000), '--wave-index', '3'], deps
    )).resolves.toBeUndefined()
    await expect(runIncidentLivePreflight(
      ['--state-file', agedState(230 * 60_000 + 1), '--wave-index', '3'], deps
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
      new Date(now - 180_001).toISOString()
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

  it('does not retry a threshold failure', async () => {
    const unhealthy = sample()
    unhealthy.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.value = 0.9
    unhealthy.sources['cloud-monitoring']!.signals['cloud_sql.cpu']!.observedAt =
      new Date(now - 180_001).toISOString()
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
    stale.sources['cloud-monitoring']!.observedAt = new Date(now - 180_001).toISOString()
    const collect = vi.fn(async () => stale)
    const wait = vi.fn(async () => undefined)
    await expect(runIncidentLivePreflight(
      ['--state-file', stateFile(), '--retry-freshness'],
      { now: () => now, collect, wait }
    )).rejects.toThrow('cloud-monitoring/source_stale')
    expect(collect).toHaveBeenCalledTimes(5)
    expect(wait).toHaveBeenCalledTimes(4)
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
