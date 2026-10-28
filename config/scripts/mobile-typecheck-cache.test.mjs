import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

it('runs uncached Bun checks like root CI and collects failures on pull requests and main', () => {
  const workflow = parse(readFileSync('.github/workflows/mobile.yml', 'utf8'))
  for (const job of [workflow.jobs.verify, workflow.jobs['main-tests']]) {
    expect(job.env.ORCA_MOBILE_TYPECHECK_COMPILER).toBe('bun')
    const steps = job.steps
    expect(
      steps.some(
        (step) => step.uses === 'actions/cache@v5' && step.with?.path?.includes('.cache/typecheck')
      )
    ).toBe(false)
    const install = steps.findIndex((step) => step.name === 'Install dependencies')
    expect(install).toBeGreaterThanOrEqual(0)
    const wait = steps.findLast((step) => step.wait)
    for (const id of ['production-types', 'test-types']) {
      const check = steps.find((step) => step.id === id)
      expect(check.if).toBeUndefined()
      expect(check.background).toBe(true)
      expect(check['continue-on-error']).toBeUndefined()
      expect(steps.indexOf(check)).toBeGreaterThan(install)
      expect(wait.wait).toContain(id)
      expect(steps.indexOf(wait)).toBeGreaterThan(steps.indexOf(check))
    }
    expect(steps.find((step) => step.id === 'production-types').run).toBe(
      'node ../config/scripts/run-typecheck-projects-in-parallel.mjs --compiler=bun --bun-threads=2 --project=mobile/tsconfig.json'
    )
    expect(steps.find((step) => step.id === 'test-types').run).toBe(
      'node scripts/check-tests-typecheck-ratchet.mjs'
    )
  }
})
