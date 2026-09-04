import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseIncidentMonitorArguments,
  runIncidentMonitorCli
} from './incident-monitor-cli.js'
import type { IncidentSample } from './incident-monitor.js'
import { RELAY_OPS_ENVIRONMENTS } from './environment-config.js'

const directories: string[] = []
const startedAt = Date.parse('2026-07-28T00:00:00.000Z')
const productionCells = RELAY_OPS_ENVIRONMENTS.production.cells.map((cell) => cell.cellId)
const selector = {
  generation: 1,
  membership: {
    existingOnly: productionCells.slice(1),
    migrationOnly: [],
    general: [productionCells[0]!]
  }
}
const selectorArguments = [
  '--expected-selector-generation',
  '1',
  '--expected-existing-only-cells',
  productionCells.slice(1).join(','),
  '--expected-migration-only-cells',
  'none',
  '--expected-general-cells',
  productionCells[0]!
]
const signal = (value: number, at: number) => ({
  value,
  observedAt: new Date(at).toISOString()
})

function sample(at: number): IncidentSample {
  const observedAt = new Date(at).toISOString()
  const cellId = 'production-gce-c1'
  return {
    collectedAt: observedAt,
    selector,
    expectedSelector: selector,
    cells: [{
      cellId,
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
          'director.latency_ms': signal(1, at),
          'auth.health': signal(1, at),
          'auth.ready': signal(1, at),
          'auth.latency_ms': signal(1, at),
          [`cell.${cellId}.health`]: signal(1, at),
          [`cell.${cellId}.ready`]: signal(1, at),
          [`cell.${cellId}.latency_ms`]: signal(1, at)
        }
      },
      'cloud-monitoring': {
        observedAt,
        signals: {
          'cloud_sql.cpu': signal(0.1, at),
          'cloud_sql.memory': signal(0.1, at),
          'cloud_sql.backends': signal(1, at),
          'cloud_sql.lock_waits': signal(0, at),
          'cloud_sql.deadlocks': signal(0, at),
          'director.instances': signal(5, at),
          'director.cpu': signal(0.1, at),
          'director.memory': signal(0.1, at),
          'director.concurrency': signal(1, at),
          'director.errors': signal(0, at),
          'auth.errors': signal(0, at)
        }
      },
      'relay-logs': {
        observedAt,
        signals: {
          'relay.pool_waiting': signal(0, at),
          'relay.pool_wait_ms': signal(0, at),
          'relay.postgres_retries': signal(0, at),
          'relay.postgres_retry_exhausted': signal(0, at),
          [`cell.${cellId}.connections`]: signal(1, at),
          [`cell.${cellId}.queued_bytes`]: signal(0, at)
        }
      },
      'director-admin': {
        observedAt,
        signals: {
          [`cell.${cellId}.admission_state`]: signal(2, at),
          [`cell.${cellId}.heartbeat_fresh`]: signal(1, at),
          [`cell.${cellId}.heartbeat_age_ms`]: signal(1, at),
          [`cell.${cellId}.migration_blocked`]: signal(0, at),
          [`cell.${cellId}.migration_target_inactive`]: signal(0, at)
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

describe('incident monitor CLI', () => {
  it('requires an exact selector and rejects invalid membership', () => {
    expect(() => parseIncidentMonitorArguments([])).toThrow(
      '--expected-selector-generation'
    )
    expect(() =>
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        '--expected-selector-generation',
        '1',
        '--expected-existing-only-cells',
        productionCells.slice(1).join(','),
        '--expected-migration-only-cells',
        'none',
        '--expected-general-cells',
        'production-gce-c99'
      ])
    ).toThrow('every configured cell exactly once')
    expect(() =>
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--interval-seconds',
        '61'
      ])
    ).toThrow('between 1 and 60')
    expect(() =>
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--duration-minutes',
        '14'
      ])
    ).toThrow('between 15 and 90')
    expect(() =>
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        '--expected-selector-generation',
        '0',
        '--expected-existing-only-cells',
        productionCells.slice(1).join(','),
        '--expected-migration-only-cells',
        productionCells[0]!,
        '--expected-general-cells',
        'none'
      ])
    ).toThrow('generation 0 cannot represent migration-only')
    expect(() =>
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--migration-policy',
        'recover-forward',
        '--pre-drain-dry-run'
      ])
    ).toThrow('requires an existing-only --recovery-source-cell-id')
    expect(() =>
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--migration-policy',
        'capacity-transition',
        '--pre-drain-dry-run'
      ])
    ).toThrow('requires a general --capacity-cell-id')
    expect(
      parseIncidentMonitorArguments([
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--migration-policy',
        'capacity-transition',
        '--capacity-cell-id',
        productionCells[0]!,
        '--pre-drain-dry-run'
      ])
    ).toMatchObject({
      migrationPolicy: 'capacity-transition',
      capacityCellId: productionCells[0]!,
      recoverySourceCellId: null
    })
  })

  it('writes private durable checkpoints for a green pre-drain dry run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-incident-cli-'))
    directories.push(directory)
    let now = startedAt
    const output: string[] = []
    const code = await runIncidentMonitorCli(
      [
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--pre-drain-dry-run',
        '--output-directory',
        directory
      ],
      {
        cwd: directory,
        now: () => now,
        wait: async (ms) => {
          now += ms
        },
        collect: async () => sample(now),
        writeOutput: (value) => output.push(value)
      }
    )
    expect(code).toBe(0)
    const statePath = join(directory, 'incident-1.state.json')
    const summaryPath = join(directory, 'incident-1.summaries.jsonl')
    const markdownPath = join(directory, 'incident-1.summary.md')
    expect(statSync(statePath).mode & 0o077).toBe(0)
    expect(statSync(summaryPath).mode & 0o077).toBe(0)
    expect(statSync(markdownPath).mode & 0o077).toBe(0)
    const summaries = readFileSync(summaryPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(summaries.map((entry) => entry.checkpointMinute)).toEqual([0, 5, 15])
    expect(output.join('')).not.toContain('token')
    expect(readFileSync(markdownPath, 'utf8')).toContain(
      '| 0 | 15 | green | 16 | none |'
    )
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      completedAt: new Date(startedAt + 15 * 60_000).toISOString(),
      frozenAt: null,
      migrationPolicy: 'strict',
      recoverySourceCellId: null,
      capacityCellId: null,
      sampleCount: 16
    })
  })

  it('runs a recovery dry run without masking blocked migrations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-incident-cli-'))
    directories.push(directory)
    let now = startedAt
    const recoverySelector = {
      generation: 1,
      membership: {
        existingOnly: ['production-gce-c1'],
        migrationOnly: [],
        general: productionCells.slice(1)
      }
    }
    const recoverySample = (): IncidentSample => {
      const current = sample(now)
      current.selector = recoverySelector
      current.expectedSelector = recoverySelector
      current.cells[0]!.expectedAdmissionState = 'existing-only'
      current.sources['director-admin']!.signals[
        'cell.production-gce-c1.admission_state'
      ] = signal(0, now)
      current.sources['director-admin']!.signals[
        'cell.production-gce-c1.migration_target_inactive'
      ] = signal(30, now)
      return current
    }
    const args = [
      '--incident-id',
      'incident-1',
      '--expected-selector-generation',
      '1',
      '--expected-existing-only-cells',
      'production-gce-c1',
      '--expected-migration-only-cells',
      'none',
      '--expected-general-cells',
      productionCells.slice(1).join(','),
      '--pre-drain-dry-run',
      '--migration-policy',
      'recover-forward',
      '--recovery-source-cell-id',
      'production-gce-c1',
      '--output-directory',
      directory
    ]
    const dependencies = {
      cwd: directory,
      now: () => now,
      wait: async (ms: number) => {
        now += ms
      },
      collect: async () => recoverySample(),
      writeOutput: () => {}
    }
    await expect(runIncidentMonitorCli(args, dependencies)).resolves.toBe(0)
    expect(
      JSON.parse(readFileSync(join(directory, 'incident-1.state.json'), 'utf8'))
    ).toMatchObject({
      migrationPolicy: 'recover-forward',
      recoverySourceCellId: 'production-gce-c1',
      capacityCellId: null,
      frozenAt: null
    })
  })

  it('fails a frozen pre-drain gate after its first sample', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-incident-cli-'))
    directories.push(directory)
    let now = startedAt
    let collections = 0
    let waits = 0
    const code = await runIncidentMonitorCli(
      [
        '--incident-id',
        'incident-1',
        ...selectorArguments,
        '--pre-drain-dry-run',
        '--output-directory',
        directory
      ],
      {
        cwd: directory,
        now: () => now,
        wait: async (ms) => {
          waits++
          now += ms
        },
        collect: async () => {
          collections++
          const unhealthy = sample(now)
          unhealthy.sources['relay-logs']!.signals['relay.pool_waiting'] =
            signal(801, now)
          return unhealthy
        },
        writeOutput: () => {}
      }
    )
    expect(code).toBe(2)
    expect(collections).toBe(1)
    expect(waits).toBe(0)
    expect(
      JSON.parse(readFileSync(join(directory, 'incident-1.state.json'), 'utf8'))
    ).toMatchObject({
      completedAt: new Date(startedAt).toISOString(),
      frozenAt: new Date(startedAt).toISOString(),
      sampleCount: 1
    })
  })

  it('requires --restart and preserves a latched freeze', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-incident-cli-'))
    directories.push(directory)
    let now = startedAt
    const args = [
      '--incident-id',
      'incident-1',
      ...selectorArguments,
      '--duration-minutes',
      '15',
      '--output-directory',
      directory
    ]
    await runIncidentMonitorCli(args, {
      cwd: directory,
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
      collect: async () => {
        const unhealthy = sample(now)
        unhealthy.sources['relay-logs']!.signals['relay.pool_waiting'] = signal(801, now)
        return unhealthy
      },
      writeOutput: () => {}
    })
    await expect(
      runIncidentMonitorCli(args, {
        cwd: directory,
        now: () => now,
        collect: async () => sample(now),
        writeOutput: () => {}
      })
    ).rejects.toThrow('pass --restart')
    const changedAdmission = [...args]
    changedAdmission[changedAdmission.indexOf('--expected-selector-generation') + 1] = '2'
    await expect(
      runIncidentMonitorCli([...changedAdmission, '--restart'], {
        cwd: directory,
        now: () => now,
        collect: async () => sample(now),
        writeOutput: () => {}
      })
    ).rejects.toThrow('do not match')
    await expect(
      runIncidentMonitorCli([...args, '--restart'], {
        cwd: directory,
        now: () => now,
        collect: async () => sample(now),
        writeOutput: () => {}
      })
    ).resolves.toBe(2)
  })

  it('resumes a gracefully segmented monitor without resetting continuity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-incident-cli-'))
    directories.push(directory)
    let now = startedAt
    const args = [
      '--incident-id',
      'incident-1',
      ...selectorArguments,
      '--duration-minutes',
      '15',
      '--output-directory',
      directory
    ]
    const dependencies = {
      cwd: directory,
      now: () => now,
      wait: async (ms: number) => {
        now += ms
      },
      collect: async () => sample(now),
      writeOutput: () => {}
    }
    await expect(
      runIncidentMonitorCli([...args, '--max-samples-this-run', '2'], dependencies)
    ).resolves.toBe(0)
    const statePath = join(directory, 'incident-1.state.json')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      completedAt: null,
      sampleCount: 2,
      lastSampleAt: new Date(startedAt + 60_000).toISOString()
    })
    await expect(
      runIncidentMonitorCli([...args, '--restart'], dependencies)
    ).resolves.toBe(0)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      completedAt: new Date(startedAt + 15 * 60_000).toISOString(),
      windowSequence: 0,
      sampleCount: 17
    })
  })
})
