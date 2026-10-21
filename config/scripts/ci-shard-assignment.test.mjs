import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RuntimeSequencer from './vitest-runtime-sequencer.mjs'
import { balanceFiles } from './ci-shard-assignment.mjs'
import { discoverE2eFiles, planE2e, verifyE2eSelection } from './ci-e2e-shard-plan.mjs'
import { parseTimingLog } from './ci-shard-timing-import.mjs'
import TimingSequencer from './ci-unit-sequencer.mjs'
import { UNIT_INCLUDE, UNIT_EXCLUDE } from './ci-unit-files.mjs'
import { NODE_RUNTIME_INCLUDE } from './vitest-node-runtime-files.mjs'
import { nodeRuntimePool } from './vitest-node-runtime-pool'

const directories = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('timing-weighted shard selection', () => {
  it('distributes long files, includes unknowns exactly once, and ignores discovery order', () => {
    const files = ['long', 'medium', 'short', 'unknown', 'new', 'zero', 'invalid']
    const timings = { long: 100, medium: 80, short: 20, zero: 0, invalid: -1, deleted: 20 }
    const plan = balanceFiles(files, 3, timings, 10)
    expect(plan).toEqual(balanceFiles(files.toReversed(), 3, timings, 10))
    expect(plan.fallbackMs).toBe(80)
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([...files].sort())
    expect(Math.max(...plan.shards.map((shard) => shard.durationMs))).toBeLessThan(250)
  })

  it('has a deterministic cold fallback and permits fewer files than shards', () => {
    expect(balanceFiles(['b', 'a'], 3, {}).shards).toEqual([
      { files: ['a'], durationMs: 1000 },
      { files: ['b'], durationMs: 1000 },
      { files: [], durationMs: 0 }
    ])
    expect(() => balanceFiles(['a', 'a'], 8, {})).toThrow('Duplicate')
    expect(() => balanceFiles(['a'], 0, {})).toThrow('count')
  })

  it('uses the post-filter Vitest discovery unchanged across eight shards', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-unit-shards-'))
    directories.push(directory)
    vi.stubEnv('ORCA_SHARD_MANIFEST', join(directory, 'assignment.json'))
    const specs = Array.from({ length: 37 }, (_, i) => ({
      moduleId: resolve(`src/fixture-${i}.test.ts`)
    }))
    const selected = []
    for (let index = 1; index <= 8; index++) {
      const sequencer = new TimingSequencer({
        config: { root: process.cwd(), shard: { index, count: 8 } }
      })
      expect(sequencer.sort).toBe(RuntimeSequencer.prototype.sort)
      selected.push(...(await sequencer.shard(specs)))
      const manifest = JSON.parse(readFileSync(join(directory, 'assignment.json'), 'utf8'))
      expect(manifest.selectedShard).toBe(index)
      expect(manifest.baselineSha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(new Set(selected).size).toBe(specs.length)
    expect(selected).toHaveLength(specs.length)
    expect(new Set(selected)).toEqual(new Set(specs))
  })

  it('keeps global sharding and isolates measurements after ordinary projects', async () => {
    vi.stubEnv('ORCA_BALANCE_UNIT_SHARDS', '1')
    const { default: config } = await import('../vitest.config')
    expect(config.test.sequence.sequencer).toBe(TimingSequencer)
    expect(config.test.maxWorkers).toBe(process.platform === 'win32' ? 4 : undefined)
    const measurementFile =
      'src/main/foreign-sqlite-readers/foreign-sqlite-reader-event-loop.test.ts'
    const projects = config.test.projects
    const measurement = projects.filter((project) => project.test.name === 'node-measurement')
    const paletteMeasurementFile =
      'src/renderer/src/lib/palette-match/palette-match-performance.test.ts'
    const paletteMeasurement = projects.filter(
      (project) => project.test.name === 'palette-measurement'
    )
    const ordinary = projects.filter((project) => project.test.sequence.groupOrder === 1)
    expect(measurement).toHaveLength(1)
    expect(ordinary).toHaveLength(process.versions.bun ? 2 : 1)
    expect(measurement[0].test).toMatchObject({
      include: [measurementFile],
      exclude: UNIT_EXCLUDE,
      maxWorkers: 1,
      sequence: { groupOrder: 2 },
      env: { ORCA_VITEST_RUNTIME: process.versions.bun ? 'node-runtime' : 'node' },
      pool: process.versions.bun ? 'node-runtime' : 'forks'
    })
    expect(measurement[0].test.poolRunner).toBe(process.versions.bun ? nodeRuntimePool : undefined)
    expect(paletteMeasurement).toHaveLength(1)
    expect(paletteMeasurement[0].test).toMatchObject({
      include: [paletteMeasurementFile],
      exclude: UNIT_EXCLUDE,
      maxWorkers: 1,
      sequence: { groupOrder: 3 },
      env: { ORCA_VITEST_RUNTIME: process.versions.bun ? 'bun' : 'node' },
      pool: 'forks'
    })
    expect(paletteMeasurement[0].test.poolRunner).toBeUndefined()
    for (const project of ordinary) {
      expect(project.test.sequence.groupOrder).toBe(1)
      expect(project.test.exclude).toEqual(
        expect.arrayContaining([measurementFile, paletteMeasurementFile])
      )
    }
    const ordinaryNode = ordinary.find((project) => project.test.name !== 'bun')
    expect(ordinaryNode.test.include).toEqual(
      process.versions.bun ? NODE_RUNTIME_INCLUDE : UNIT_INCLUDE
    )
    const ordinaryBun = ordinary.find((project) => project.test.name === 'bun')
    if (process.versions.bun) {
      expect(ordinaryBun.test.exclude).toEqual(
        expect.arrayContaining([...NODE_RUNTIME_INCLUDE, measurementFile])
      )
    }
  })

  it.each([
    { name: 'absent', path: undefined, enabled: false },
    { name: 'empty', path: '', enabled: false },
    { name: 'explicit', path: join(tmpdir(), 'orca-unit-cache-experiment'), enabled: true }
  ])(
    'uses persistent transforms only with an explicit cache path ($name)',
    async ({ path, enabled }) => {
      vi.stubEnv('ORCA_UNIT_MODULE_CACHE_PATH', path)
      vi.resetModules()
      const { default: config } = await import('../vitest.config')
      for (const test of [config.test, ...config.test.projects.map((project) => project.test)]) {
        expect(test.fsModuleCache).toBe(enabled)
        expect(test.fsModuleCachePath).toBe(enabled ? path : undefined)
      }
    }
  )

  it('keeps nested/serial E2E files atomic and fails closed on discovery errors', () => {
    const spec = (id, file) => ({ id, file, tests: [{ projectName: 'electron-headless' }] })
    const report = {
      suites: [
        {
          specs: [spec('a', 'one.spec.ts')],
          suites: [{ specs: [spec('b', 'one.spec.ts'), spec('c', 'two.spec.ts')] }]
        }
      ]
    }
    const plan = planE2e(report, 14, { timings: { 'tests/e2e/one.spec.ts': 4000 } })
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([
      'one.spec.ts',
      'two.spec.ts'
    ])
    expect(plan.testsByFile['one.spec.ts']).toHaveLength(2)
    expect(() => discoverE2eFiles({ ...report, errors: [{}] })).toThrow('errors')
    expect(() => discoverE2eFiles({ suites: [] })).toThrow('no tests')
    expect(() =>
      discoverE2eFiles({ suites: [{ specs: [spec('a', '../escape.spec.ts')] }] })
    ).toThrow('Unsafe')
    expect(() =>
      discoverE2eFiles({
        suites: [{ specs: [spec('a', 'one.spec.ts'), spec('a', 'one.spec.ts')] }]
      })
    ).toThrow('Duplicate')
  })

  it('plans only general E2E specs and rejects unexpected dedicated selections', () => {
    const spec = (id, file) => ({ id, file, tests: [{ projectName: 'electron-headless' }] })
    const report = {
      suites: [
        {
          specs: [
            spec('general', 'general.spec.ts'),
            spec('layout', 'workspace-layout-oracle-headless.spec.ts'),
            spec('ssh', 'ssh-orcad-terminal.spec.ts')
          ]
        }
      ]
    }
    expect(Object.keys(discoverE2eFiles(report))).toEqual([
      'general.spec.ts',
      'ssh-orcad-terminal.spec.ts',
      'workspace-layout-oracle-headless.spec.ts'
    ])
    const assignment = { ...planE2e(report, 1, { timings: {} }), selectedShard: 1 }
    expect(assignment.shards[0].files).toEqual(['general.spec.ts'])
    expect(Object.keys(assignment.testsByFile)).toEqual(['general.spec.ts'])
    const general = report.suites[0].specs[0]
    expect(() => verifyE2eSelection(assignment, { suites: [{ specs: [general] }] })).not.toThrow()
    for (const dedicated of report.suites[0].specs.slice(1)) {
      expect(() =>
        verifyE2eSelection(assignment, { suites: [{ specs: [general, dedicated] }] })
      ).toThrow('differs')
    }
    expect(() =>
      planE2e({ suites: [{ specs: report.suites[0].specs.slice(1) }] }, 1, { timings: {} })
    ).toThrow('no general E2E tests')
  })

  it('imports ANSI unit timings and E2E failures without counting headful reruns', () => {
    const parsed = parseTimingLog(
      [
        '\u001b[32m✓\u001b[39m src/a.test.ts (2 tests) 35ms',
        'Duration 1s (transform 0.1s, setup 0.2s, import 0.3s, tests 0.04s, environment 0.4s)',
        '✓ 1 [electron-headless] › tests/e2e/a.spec.ts:1:1 › works (2s)',
        '✘ 2 [electron-headless] › tests/e2e/a.spec.ts:2:1 › fails (1.2m)',
        '✓ 3 [electron-headful] › tests/e2e/a.spec.ts:3:1 › benchmark (9s)'
      ].join('\n')
    )
    expect(parsed).toEqual({
      unit: { 'src/a.test.ts': 35 },
      e2e: { 'tests/e2e/a.spec.ts': 74000 },
      overheadMs: 1000
    })
  })

  it('reads mixed units from captured Vitest output', () => {
    const parsed = parseTimingLog(
      'Duration 5.14s (transform 952ms, setup 449ms, import 1.18s, tests 9.41s, environment 1ms)'
    )
    expect(parsed.overheadMs).toBe(2582)
  })

  it('rejects incomplete unit evidence instead of silently dropping overhead', () => {
    expect(() => parseTimingLog('✓ src/a.test.ts (2 tests) 35ms')).toThrow('Duration summary')
  })
})
