import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseSequencer } from 'vitest/node'
import { balanceFiles } from './ci-shard-assignment.mjs'
import { discoverE2eFiles, planE2e } from './ci-e2e-shard-plan.mjs'
import { parseTimingLog } from './ci-shard-timing-import.mjs'
import TimingSequencer from './ci-unit-sequencer.mjs'

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

  it('uses the post-filter Vitest discovery unchanged across eight shards and retains default sort', async () => {
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
      expect(sequencer.sort).toBe(BaseSequencer.prototype.sort)
      selected.push(...(await sequencer.shard(specs)))
      const manifest = JSON.parse(readFileSync(join(directory, 'assignment.json'), 'utf8'))
      expect(manifest.selectedShard).toBe(index)
      expect(manifest.baselineSha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(new Set(selected).size).toBe(specs.length)
    expect(selected).toHaveLength(specs.length)
    expect(new Set(selected)).toEqual(new Set(specs))
  })

  it('wires a constructor into the opt-in Vitest config', async () => {
    vi.stubEnv('ORCA_BALANCE_UNIT_SHARDS', '1')
    const { default: config } = await import('../vitest.config')
    expect(config.test.sequence.sequencer).toBe(TimingSequencer)
  })

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
