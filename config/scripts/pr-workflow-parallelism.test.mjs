import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const unitTestWorkflow = parse(readFileSync('.github/workflows/unit-tests.yml', 'utf8'))
const planWorkflow = parse(readFileSync('.github/workflows/unit-plan.yml', 'utf8'))
const evidenceWorkflow = parse(
  readFileSync('.github/workflows/unit-selection-evidence.yml', 'utf8')
)

describe('PR workflow parallelism', () => {
  it.each([
    ['shadow', false, true],
    ['shadow', true, true],
    ['selected', false, true],
    ['selected', true, false],
    ['', true, true]
  ])('plans only once for mode %s, draft %s', (mode, draft, deferred) => {
    const evaluate = (expression, context) => runInNewContext(expression.slice(3, -2), context)
    const context = {
      vars: { ORCA_UNIT_SELECTION_MODE: mode },
      github: { event: { pull_request: { draft } } }
    }
    const inputs = {
      defer_shadow: evaluate(workflow.jobs.unit_plan.with.defer_shadow, context),
      selection_mode: evaluate(workflow.jobs.unit_plan.with.selection_mode, context)
    }
    const planContext = { ...context, inputs }
    expect(evaluate(planWorkflow.jobs.plan.env.DEFER_SHADOW, planContext)).toBe(deferred)
    // Downstream jobs read the plan's output rather than re-deriving the draft condition.
    const planned = String(evaluate(planWorkflow.jobs.plan.outputs.selection_planned, planContext))
    const needs = { unit_plan: { outputs: { selection_planned: planned } } }
    expect(evaluate(workflow.jobs.test.with.download_selection_plan, { needs })).toBe(!deferred)
    expect(evaluate(workflow.jobs.unit_selection_evidence.with.rebuild_plan, { needs })).toBe(
      deferred
    )
  })

  it('keeps advisory unit-selection evidence off the gate', () => {
    // Keep advisory continue-on-error work off unit-tests.yml’s critical path: caller needs:test otherwise waits ~36s beyond last shard.
    const evidence = workflow.jobs.unit_selection_evidence
    expect(evidence.uses).toBe('./.github/workflows/unit-selection-evidence.yml')
    expect(evidence.needs).toEqual(['unit_plan', 'test'])
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
    const job = evidenceWorkflow.jobs.selection_evidence
    expect(job['continue-on-error']).toBe(true)
  })

  it.each([undefined, 'false', 'true'])(
    'runs the advisory CLI without an action credential and preserves failures (deferred %s)',
    async (rebuild) => {
      const steps = evidenceWorkflow.jobs.selection_evidence.steps
      expect(steps.some((step) => step.uses?.startsWith('actions/setup-node@'))).toBe(false)
      const comparison = steps.find((step) => step.name === 'Compare selection with full results')
      expect(comparison.uses).toBe('actions/github-script@v8')
      expect(comparison.with['github-token']).toBe('unused')
      const publicEnv = {
        GITHUB_STEP_SUMMARY: '/tmp/summary',
        ...(rebuild === undefined ? {} : { REBUILD_SELECTION_PLAN: rebuild })
      }
      const env = { ...publicEnv, 'INPUT_GITHUB-TOKEN': 'test-token' }
      const failure = new Error('comparison failed')
      const result = runInNewContext(`(async () => { ${comparison.with.script} })()`, {
        process: { env, execPath: '/bundled/node24' },
        exec: {
          exec: async (command, args, options) => {
            expect(command).toBe('/bundled/node24')
            expect(args).toEqual([
              'config/scripts/ci-unit-selection-review.mjs',
              'unit-evidence',
              ...(rebuild === 'true' ? ['ci-shards/unit-selection.json'] : [])
            ])
            expect(options.env).toEqual(publicEnv)
            throw failure
          }
        }
      })
      await expect(result).rejects.toBe(failure)
      expect(env['INPUT_GITHUB-TOKEN']).toBe('test-token')
    }
  )
})
