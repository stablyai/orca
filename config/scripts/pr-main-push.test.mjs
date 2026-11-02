import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const evaluate = (expression, github) =>
  compileAggregateExpression(expression, ['github'])({ github }).coerceString()

describe('main push runs of PR Checks', () => {
  it('run every main commit to completion without cancelling one another', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'] })
    const push = { event_name: 'push', sha: 'abc', event: {} }
    const pr = { event_name: 'pull_request', sha: 'def', event: { pull_request: { number: 7 } } }
    expect(evaluate(workflow.concurrency.group, push)).toBe('main-checks-abc')
    expect(evaluate(workflow.concurrency['cancel-in-progress'], push)).toBe('false')
    expect(evaluate(workflow.concurrency.group, pr)).toBe('pr-checks-7')
    expect(evaluate(workflow.concurrency['cancel-in-progress'], pr)).toBe('true')
  })

  it('select every job, and run every input-scoped step in full', () => {
    const classify = workflow.jobs.code_paths.steps.find((step) => step.id === 'filter')
    expect(classify.run).toContain(`if [ "$GITHUB_EVENT_NAME" = push ]; then CHANGED=''`)
    for (const name of [
      'Verify localization extraction',
      'Check VM runtime rollback compatibility',
      'Decide whether the orcad terminal smoke runs',
      'Select per-file lint scope'
    ]) {
      const step = workflow.jobs.preflight.steps.find((candidate) => candidate.name === name)
      expect(step.run, name).toContain('[ "$GITHUB_EVENT_NAME" = pull_request ]')
    }
  })

  it('report a result for main pushes through the aggregate', () => {
    const verify = compileAggregateExpression(workflow.jobs.verify.if, ['github'])
    expect(verify({ github: { event_name: 'push', event: {} } }).coerceString()).toBe('true')
  })
})
