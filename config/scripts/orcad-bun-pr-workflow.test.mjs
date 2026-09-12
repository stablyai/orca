import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('PR bundled Bun orcad gate', () => {
  it('packages release relays through the complete cross-platform builder', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(scripts['build:release']).toContain('pnpm run build:relay:release')
    expect(scripts['build:release:parallel']).toContain('pnpm run build:relay:release')
  })

  it('runs the complete built-artifact smoke after the Node rollback smoke', () => {
    const steps = workflow.jobs.static_analysis.steps
    const nodeIndex = steps.findIndex(
      (step) => step.name === 'Boot orcad and round-trip a terminal'
    )
    const bunIndex = steps.findIndex(
      (step) => step.name === 'Verify the complete bundled Bun orcad runtime'
    )

    expect(nodeIndex).toBeGreaterThanOrEqual(0)
    expect(bunIndex).toBeGreaterThan(nodeIndex)
    expect(steps[bunIndex].run).toBe('pnpm run smoke:orcad-bun:built')
  })
})
