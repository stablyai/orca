import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('release-cut stable version floor', () => {
  it('uses the package floor for the next patch instead of bumping past it', () => {
    const workflow = parse(
      readFileSync(resolve(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const step = workflow.jobs.cut.steps.find(({ name }) => name === 'Compute next version')

    expect(step.run).toContain('package_floor_candidate')
    expect(step.run).toContain('expected_patch="$(bump "$latest_stable" patch)"')
    expect(step.run).toContain('Using package.json release floor as the next stable patch')
    expect(step.run).toContain('refusing to auto-skip stable versions')
    expect(step.run).toContain('"$explicit" != "$package_floor_candidate"')
  })
})
