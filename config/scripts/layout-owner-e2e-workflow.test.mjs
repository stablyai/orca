import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { selectGeneralE2eSpecs } from './ci-e2e-job-selection.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const read = (file) => readFileSync(join(projectDir, file), 'utf8')
const e2eWorkflow = parse(read('.github/workflows/e2e.yml'))
const job = parse(read('.github/workflows/layout-owner-e2e.yml')).jobs.layout_owner_window

describe('layout owner rollback build', () => {
  it('runs the layout specs on the ORCA_LAYOUT_OWNER=window build and checks its marker', () => {
    expect(job.uses).toBe('./.github/workflows/e2e.yml')
    expect(job.with.layout_owner).toBe('window')
    const marker = e2eWorkflow.jobs.build.steps.find(
      (step) => step.name === 'Check layout-owner build marker'
    )
    expect(marker.run).toContain('test -f out/main/ORCA_LAYOUT_OWNER_WINDOW')
    expect(e2eWorkflow.on.workflow_call.inputs.layout_owner.default).toBe('')
  })

  it('runs every spec gated on main owning the layout, there and in the general lane', () => {
    const specs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => `tests/e2e/${file}`)
    const gated = specs.filter((spec) => read(spec).includes('LAYOUT_OWNER_BUILD'))
    expect(gated.length).toBeGreaterThanOrEqual(4)
    // A marker read would skip silently in shipped builds, which leave no marker.
    expect(specs.filter((spec) => read(spec).includes('ORCA_LAYOUT_OWNER_'))).toEqual([])
    expect(selectGeneralE2eSpecs(gated)).toEqual(gated)
    expect(JSON.parse(job.with.test_files)).toEqual(expect.arrayContaining(gated))
  })
})
