import { expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import { summarizePRChecks } from './pr-checks-presentation'

function check(over: Partial<PRCheckDetail>): PRCheckDetail {
  return {
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    url: null,
    ...over
  }
}

it('presents cancellations without hiding real failure or pending checks', () => {
  const cancelled = check({ conclusion: 'cancelled' })
  expect(summarizePRChecks([cancelled, check({})])).toMatchObject({
    outcome: 'cancelled',
    failed: 0,
    cancelled: 1,
    label: '1 Cancelled · 1 passed'
  })
  expect(summarizePRChecks([cancelled, check({ conclusion: 'pending' })]).outcome).toBe('pending')
  expect(summarizePRChecks([cancelled, check({ conclusion: 'failure' })]).outcome).toBe('failure')
})
