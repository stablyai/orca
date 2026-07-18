import { availableParallelism } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  resolveElectronE2eWorkerCount,
  resolveUnitTestWorkerCount
} from './interactive-test-worker-budget.mjs'

describe('interactive test worker budget', () => {
  it.each([
    [12, 4],
    [8, 4],
    [6, 3],
    [4, 2],
    [2, 1],
    [1, 1]
  ])('uses %i logical CPUs without starving the interactive session', (logicalCpus, expected) => {
    expect(resolveUnitTestWorkerCount(logicalCpus)).toBe(expected)
  })

  it.each([
    [false, 12, 2],
    [false, 4, 2],
    [false, 2, 1],
    [false, 1, 1],
    [true, 12, 1]
  ])(
    'uses %i Electron E2E workers when CI=%s and logical CPUs=%i',
    (isCi, logicalCpus, expected) => {
      expect(resolveElectronE2eWorkerCount(isCi, logicalCpus)).toBe(expected)
    }
  )

  it('wires the budgets into both full-suite configs', async () => {
    const [{ default: vitestConfig }, { default: playwrightConfig }] = await Promise.all([
      import('../vitest.config.ts'),
      import('../../tests/playwright.config.ts')
    ])

    expect(vitestConfig.test.maxWorkers).toBe(resolveUnitTestWorkerCount(availableParallelism()))
    expect(playwrightConfig.workers).toBe(
      resolveElectronE2eWorkerCount(Boolean(process.env.CI), availableParallelism())
    )
  })
})
