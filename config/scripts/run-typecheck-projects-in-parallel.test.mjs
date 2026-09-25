import { describe, expect, it } from 'vitest'
import {
  TYPECHECK_PROJECTS,
  admissibleHeapGib,
  planTypecheckBatches
} from './run-typecheck-projects-in-parallel.mjs'

const CI_RUNNER = { totalBytes: 16 * 1024 ** 3, parallelism: 4 }
const DEV_LAPTOP = { totalBytes: 64 * 1024 ** 3, parallelism: 18 }

function planFor({ totalBytes, parallelism }, projects = TYPECHECK_PROJECTS) {
  return planTypecheckBatches(projects, {
    budgetGib: admissibleHeapGib(totalBytes),
    parallelism
  })
}

function batchOf(batches, config) {
  return batches.findIndex((batch) => batch.some((project) => project.config === config))
}

describe('typecheck project admission', () => {
  it('keeps the two expensive projects off the same CI runner', () => {
    const batches = planFor(CI_RUNNER)
    expect(batchOf(batches, 'tsconfig.node.json')).not.toBe(
      batchOf(batches, 'tsconfig.tc.web.json')
    )
  })

  it('holds every CI batch inside the memory budget', () => {
    const budget = admissibleHeapGib(CI_RUNNER.totalBytes)
    for (const batch of planFor(CI_RUNNER)) {
      const claimed = batch.reduce((total, project) => total + project.heapGib, 0)
      expect(claimed).toBeLessThanOrEqual(budget)
    }
  })

  it('still fills a CI batch with the cheap projects rather than serializing everything', () => {
    // Why: strict serialization measured ~60% slower than pairing the cheap work alongside.
    expect(planFor(CI_RUNNER).length).toBeLessThan(TYPECHECK_PROJECTS.length)
  })

  it('leaves a roomy machine fully parallel', () => {
    expect(planFor(DEV_LAPTOP)).toHaveLength(1)
  })

  it('serializes on a single core', () => {
    const batches = planFor({ totalBytes: 64 * 1024 ** 3, parallelism: 1 })
    expect(batches).toHaveLength(TYPECHECK_PROJECTS.length)
    expect(batches.every((batch) => batch.length === 1)).toBe(true)
  })

  it('runs a project that alone exceeds the budget instead of stalling', () => {
    const batches = planTypecheckBatches([{ config: 'huge.json', heapGib: 512 }], {
      budgetGib: admissibleHeapGib(2 * 1024 ** 3),
      parallelism: 4
    })
    expect(batches).toEqual([[{ config: 'huge.json', heapGib: 512 }]])
  })

  it('schedules every project exactly once', () => {
    const scheduled = planFor(CI_RUNNER)
      .flat()
      .map((project) => project.config)
      .sort()
    expect(scheduled).toEqual(TYPECHECK_PROJECTS.map((project) => project.config).sort())
  })

  it('never lets one project outgrow a CI runner on its own', () => {
    // A single project over budget runs anyway, so this is the ceiling the pool cannot rescue.
    const heaviest = Math.max(...TYPECHECK_PROJECTS.map((project) => project.heapGib))
    expect(heaviest).toBeLessThanOrEqual(admissibleHeapGib(CI_RUNNER.totalBytes))
  })
})
