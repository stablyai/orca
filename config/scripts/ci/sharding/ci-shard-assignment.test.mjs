import { describe, expect, it } from 'vitest'
import { discoverE2eFiles, planE2e } from '../e2e-selection/ci-e2e-shard-plan.mjs'

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
})
