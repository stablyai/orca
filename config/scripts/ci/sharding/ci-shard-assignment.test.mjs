import { describe, expect, it } from 'vitest'
import { discoverE2eFiles, planE2e } from '../e2e-selection/ci-e2e-shard-plan.mjs'
import { parseTimingLog } from './ci-shard-timing-import.mjs'

describe('timing-weighted shard selection', () => {
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

  it('rejects incomplete unit evidence instead of silently dropping overhead', () => {
    expect(() => parseTimingLog('✓ src/a.test.ts (2 tests) 35ms')).toThrow('Duration summary')
  })
})
