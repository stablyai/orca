import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

describe('cross-version wire lane contract', () => {
  const crossVersionStep = prWorkflow.jobs['cross-version-wire'].steps.find(
    (step) => step.name === 'Old/new client and server compatibility journeys'
  )
  const crossVersionDir = 'tests/e2e/cross-version-wire'

  it('runs every suite in the cross-version directory', () => {
    // Why derive from the directory rather than pin a list: a new suite that is
    // never named in the job is a lane that silently covers nothing, which is how
    // orchestration went uncovered while the harness itself was healthy.
    const onDisk = readdirSync(join(projectDir, crossVersionDir))
      .filter((name) => name.endsWith('.unit.test.ts'))
      .map((name) => `${crossVersionDir}/${name}`)
      .sort()
    const listed = crossVersionStep.run
      .split(/\s+/)
      .filter((token) => token.startsWith(`${crossVersionDir}/`))
      .sort()
    expect(onDisk.length).toBeGreaterThan(0)
    expect(listed).toEqual(onDisk)
  })

  it('covers the orchestration federation surface', () => {
    // The suite exists because #19689 shipped: a released coordinator lost its Run
    // id on federationAttachStart and no lane paired two builds over that method.
    expect(readdirSync(join(projectDir, crossVersionDir))).toContain(
      'cross-version-orchestration-wire.unit.test.ts'
    )
    expect(crossVersionStep.run).toContain(
      `${crossVersionDir}/cross-version-orchestration-wire.unit.test.ts`
    )
    // Full history: the suite extracts two release tags, and a shallow clone has none.
    const checkout = prWorkflow.jobs['cross-version-wire'].steps.find(
      (step) => step.uses?.startsWith('actions/checkout')
    )
    expect(checkout.with['fetch-depth']).toBe(0)
  })
})
