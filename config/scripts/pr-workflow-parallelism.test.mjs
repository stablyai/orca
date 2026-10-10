import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const unitTestWorkflow = parse(readFileSync('.github/workflows/unit-tests.yml', 'utf8'))

describe('PR workflow parallelism', () => {
  it('enforces process-host boundaries in the required static-analysis checks', () => {
    const guard = workflow.jobs.preflight.steps.find((step) =>
      step.run?.includes('pnpm run check:process-host-imports')
    )
    expect(guard?.if).toBe("needs.code_paths.outputs.static_analysis == 'true'")
    expect(guard?.['continue-on-error']).toBeUndefined()
  })

  it('keeps advisory unit-selection evidence off the gate', () => {
    // It is continue-on-error, so it can never fail a PR. Living inside unit-tests.yml made a
    // caller's `needs: test` wait for it anyway, holding verify ~36s past the last shard. Pinned
    // here so it cannot drift back onto the critical path.
    const evidence = workflow.jobs.unit_selection_evidence
    expect(evidence.uses).toBe('./.github/workflows/unit-selection-evidence.yml')
    expect(evidence.needs).toEqual(['test'])
    for (const [result, cancelled, expected] of [
      ['success', false, true],
      ['failure', false, true],
      ['skipped', false, false],
      ['cancelled', false, false],
      ['success', true, false],
      ['failure', true, false]
    ]) {
      expect(
        runInNewContext(evidence.if.slice(3, -2), {
          cancelled: () => cancelled,
          needs: { test: { result } }
        })
      ).toBe(expected)
    }
    expect(workflow.jobs.verify.needs).not.toContain('unit_selection_evidence')
    expect(unitTestWorkflow.jobs.selection_evidence).toBeUndefined()
    const evidenceWorkflow = parse(
      readFileSync('.github/workflows/unit-selection-evidence.yml', 'utf8')
    )
    const job = evidenceWorkflow.jobs.selection_evidence
    expect(job['continue-on-error']).toBe(true)
  })
})
