import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { verifyRequiredPrContext } from '../../../../.github/scripts/check-required-pr-context.mjs'

it('rejects aggregate conditions that hide a successful result', () => {
  for (const condition of [undefined, 'success()', 'always()', '!cancelled() && !(true)']) {
    const parseChanged = (source) => {
      const workflow = parse(source)
      if (workflow.jobs.verify?.name === 'PR checks passed') {
        workflow.jobs.verify.if = condition
      }
      return workflow
    }
    expect(() => verifyRequiredPrContext(parseChanged), String(condition)).toThrow(
      'Required PR aggregate must run unless cancelled or the PR is a draft.'
    )
  }
})

it('rejects aggregate jobs and steps that ignore failures', () => {
  for (const location of ['job', 'step']) {
    const parseChanged = (source) => {
      const workflow = parse(source)
      if (workflow.jobs.verify?.name === 'PR checks passed') {
        const target = location === 'job' ? workflow.jobs.verify : workflow.jobs.verify.steps[0]
        target['continue-on-error'] = true
      }
      return workflow
    }
    expect(() => verifyRequiredPrContext(parseChanged), location).toThrow(
      'Required PR aggregate must not ignore failures.'
    )
  }
})
