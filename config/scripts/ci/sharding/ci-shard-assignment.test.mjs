import { describe, expect, it } from 'vitest'
import { balanceFiles } from './ci-shard-assignment.mjs'
import {
  discoverE2eFiles,
  planE2e,
  verifyE2eSelection
} from '../e2e-selection/ci-e2e-shard-plan.mjs'
import { parseTimingLog } from './ci-shard-timing-import.mjs'

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
