import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/packaged-browser-e2e.yml', import.meta.url), 'utf8')
)
const steps = workflow.jobs.compatibility.steps

describe('packaged browser compatibility lane', () => {
  it('runs weekly and supports immutable manual or reusable revisions', () => {
    expect(workflow.on.schedule).toHaveLength(1)
    for (const trigger of ['workflow_dispatch', 'workflow_call']) {
      expect(workflow.on[trigger].inputs.ref).toMatchObject({ type: 'string', required: false })
    }
    expect(steps[0].with.ref).toBe('${{ inputs.ref || github.sha }}')
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('verifies the pinned package before selecting the desktop executable', () => {
    const download = steps.find((step) => step.name === 'Download pinned old release').run
    expect(download).toContain('gh release download v1.4.188')
    expect(download).toContain('hashlib.sha512(package.read_bytes())')
    expect(download).toContain("extracted/'opt'/'Orca'/'orca-ide'")
    expect(download).toContain('assert base64.')
    expect(download).toContain('decode()==expected')
    expect(download).toContain("['dpkg-deb'")
    expect(download.indexOf('assert base64.')).toBeLessThan(download.indexOf("['dpkg-deb'"))
  })

  it('requires both directions three times and rejects silent skips', () => {
    const run = steps.find((step) => step.name === 'Run both mixed-version directions')
    expect(run.run).toContain('tests/e2e/packaged-mixed-version-browser-placement.spec.ts')
    expect(run.run).toContain('--repeat-each=3')
    expect(run.run).toContain('--retries=0')
    expect(run.run).toContain('--reporter=list,json')
    const verify = steps.find((step) => step.name === 'Require all six compatibility executions')
    expect(verify.if).toBe('always()')
    expect(verify.run).toBe(
      `node config/scripts/verify-packaged-browser-participation.mjs ${run.env.PLAYWRIGHT_JSON_OUTPUT_FILE}`
    )
    expect(steps.at(-1).if).toBe('always()')
    expect(steps.at(-1).with.path).toBe('test-results/')
  })
})
