import { describe, expect, it } from 'vitest'
import {
  aggregateJob,
  aggregateNeeds,
  aggregateRequiredJobs,
  aggregateSelectors,
  aggregateShell,
  aggregateShouldRun,
  aggregateWorkflow,
  compileAggregateExpression
} from './pr-aggregate-gate-context.mjs'

const results = ['success', 'failure', 'cancelled', 'skipped', '', 'unknown', undefined, null]
const admitted = (needs, cancelled = false) =>
  aggregateShouldRun(
    { needs, github: { event: { pull_request: { draft: false } } } },
    cancelled
  ).coerceString() === 'true'

describe('explicit PR aggregate result', () => {
  it('keeps every required dependency and the existing failure reporter', () => {
    expect(aggregateJob.name).toBe('PR checks passed')
    expect(aggregateJob.needs).toEqual([
      'code_paths',
      'preflight',
      ...aggregateSelectors.filter((job) => job !== 'static_analysis' && job !== 'typecheck')
    ])
    for (const job of ['e2e', 'terminal_ime_native', 'windows_wsl', 'unit_selection_evidence']) {
      expect(aggregateJob.needs).not.toContain(job)
    }
    expect(aggregateJob['continue-on-error']).toBeUndefined()
    expect(aggregateShell['continue-on-error']).toBeUndefined()
    expect(aggregateShell.run).toContain('"$CODE_PATHS" != "success"')
    const checked = [...aggregateShell.run.matchAll(/^check_job (\S+) /gm)].map((match) => match[1])
    expect(checked).toEqual(aggregateRequiredJobs)
  })

  it('runs for code, docs, reused and mixed plans after every dependency outcome', () => {
    for (const selected of ['true', 'false']) {
      const plan = aggregateNeeds(selected)
      expect(admitted(plan)).toBe(true)
      for (const job of aggregateJob.needs) {
        for (const result of results) {
          const needs = aggregateNeeds(selected)
          needs[job].result = result
          expect(admitted(needs), `${selected}/${job}/${result}`).toBe(true)
          expect(admitted(needs, true), `${selected}/${job}/${result}`).toBe(false)
        }
        const missing = aggregateNeeds(selected)
        delete missing[job]
        expect(admitted(missing), `${selected}/${job}/missing`).toBe(true)
        expect(admitted(missing, true), `${selected}/${job}/missing`).toBe(false)
      }
    }
    expect(admitted(aggregateNeeds('false', { test: 'true', typecheck: 'true' }))).toBe(true)
    expect(admitted({})).toBe(true)
    expect(admitted({}, true)).toBe(false)
  })

  it('passes raw preflight selectors to the shell before case-insensitive Actions comparisons', () => {
    const outputs = aggregateWorkflow.jobs.code_paths.outputs
    for (const [variable, output] of [
      ['STATIC_ANALYSIS_SHOULD_RUN', 'static_analysis'],
      ['TYPECHECK_SHOULD_RUN', 'typecheck']
    ]) {
      expect(aggregateShell.env[variable]).toBe(`\${{ needs.code_paths.outputs.${output} }}`)
      expect(outputs[output]).toContain(`steps.filter.outputs.${output}`)
    }
    const compare = compileAggregateExpression("needs.value == 'true'")
    expect(compare({ needs: { value: 'TRUE' } }).coerceString()).toBe('true')
  })
})
