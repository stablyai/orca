import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

it('runs full native checks and collects failures on pull requests and main', () => {
  const workflow = parse(readFileSync('.github/workflows/mobile.yml', 'utf8'))
  for (const job of [workflow.jobs.verify, workflow.jobs['main-tests']]) {
    expect(job.env.ORCA_MOBILE_TYPECHECK_COMPILER).toBe('native')
    expect(job.env.ORCA_MOBILE_TYPECHECK_CACHE_DIR).toBeUndefined()
    const steps = job.steps
    expect(
      steps.some(
        (step) =>
          step.uses === 'actions/cache@v5' && step.with?.path?.includes('mobile/.cache/typechecks')
      )
    ).toBe(false)
    const install = steps.findIndex((step) => step.name === 'Install dependencies')
    const wait = steps.find((step) => step.wait)
    for (const id of ['production-types', 'test-types']) {
      const check = steps.find((step) => step.id === id)
      expect(check.if).toBeUndefined()
      expect(check.background).toBe(true)
      expect(check['continue-on-error']).toBeUndefined()
      expect(check.env.GOMAXPROCS).toBe('2')
      expect(steps.indexOf(check)).toBeGreaterThan(install)
      expect(wait.wait).toContain(id)
      expect(steps.indexOf(wait)).toBeGreaterThan(steps.indexOf(check))
    }
    expect(steps.find((step) => step.id === 'production-types').run).toBe(
      'node scripts/typecheck-mobile.mjs'
    )
    expect(steps.find((step) => step.id === 'test-types').run).toBe(
      'node scripts/check-tests-typecheck-ratchet.mjs'
    )
  }
})
