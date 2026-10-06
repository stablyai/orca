import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/mobile.yml', 'utf8'))
const packageJson = JSON.parse(readFileSync('mobile/package.json', 'utf8'))
const job = workflow.jobs.verify
const steps = job.steps

describe('mobile verification command ownership', () => {
  it('runs the declared checks through installed tools without a script-time install', () => {
    const production = steps.find((step) => step.name === 'Typecheck')
    const tests = steps.find((step) => step.name === 'Typecheck tests (ratchet)')

    expect(packageJson.scripts.typecheck).toMatch(/^tsc\b/)
    expect(production.run).toBe(`node node_modules/typescript/bin/${packageJson.scripts.typecheck}`)
    expect(tests.run).toBe(packageJson.scripts['check:tests-typecheck'])
    expect(tests.run).toMatch(/^node\s/)
    expect(job.defaults.run['working-directory']).toBe('mobile')
    for (const name of ['typecheck', 'check:tests-typecheck']) {
      expect(packageJson.scripts[`pre${name}`]).toBeUndefined()
      expect(packageJson.scripts[`post${name}`]).toBeUndefined()
    }
  })

  it('finishes installation and joins both independent typechecks before tests', () => {
    const installIndex = steps.findIndex((step) => step.name === 'Install dependencies')
    const productionIndex = steps.findIndex((step) => step.name === 'Typecheck')
    const ratchetIndex = steps.findIndex((step) => step.name === 'Typecheck tests (ratchet)')
    const waitIndex = steps.findIndex((step) => step.wait === steps[productionIndex].id)
    const testIndex = steps.findIndex((step) => step.name === 'Test')

    expect(steps[installIndex].run).toBe('pnpm install --frozen-lockfile')
    expect(steps[installIndex].background ?? false).toBe(false)
    expect(installIndex).toBeLessThan(productionIndex)
    expect(steps[productionIndex].background).toBe(true)
    expect(productionIndex).toBeLessThan(ratchetIndex)
    expect(waitIndex).toBeGreaterThan(productionIndex)
    expect(ratchetIndex).toBeLessThan(waitIndex)
    expect(waitIndex).toBeLessThan(testIndex)
    expect(steps[waitIndex].if).toBeUndefined()
    expect(steps[productionIndex]['continue-on-error'] ?? false).toBe(false)
    expect(steps[ratchetIndex]['continue-on-error'] ?? false).toBe(false)
  })
})
