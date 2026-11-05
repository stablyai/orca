import { afterEach, expect, it } from 'vitest'
import { buildPrGateRows } from './pr-tab-gates'
import { markCompletePRCheckOwner } from '../../../../src/shared/github/complete-pr-check-owner'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { activateMobileUiLocale } from '../../i18n/mobile-i18n'
const pr: PRInfo = {
  number: 42,
  title: 'PR',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/42',
  checksStatus: 'failure',
  updatedAt: '2026-11-04',
  mergeable: 'UNKNOWN',
  headSha: 'head'
}
const checks = [
  { name: 'Build', status: 'completed' as const, conclusion: 'success' as const, url: null }
]
afterEach(() => activateMobileUiLocale('en'))
it.each(['en', 'es'] as const)(
  'keeps the whole PR blocking with partial passing rows in %s',
  async (locale) => {
    await activateMobileUiLocale(locale)
    const owner = markCompletePRCheckOwner(
      {
        ...pr,
        checksSummary: {
          state: 'failure',
          total: 101,
          passed: 100,
          failed: 1,
          cancelled: 0,
          pending: 0,
          neutral: 0
        }
      },
      'host-epoch'
    )
    expect(
      buildPrGateRows({ pr: owner, details: null, checks, checksError: null })[0]
    ).toMatchObject({ key: 'checks', tone: 'blocking' })
    expect(
      buildPrGateRows({ pr: owner, details: null, checks, checksError: 'Rows unavailable' })[0].tone
    ).toBe('blocking')
    // The unchanged host path keeps its existing row-based display.
    expect(buildPrGateRows({ pr, details: null, checks, checksError: null })[0].tone).toBe('passed')
  }
)
it('does not certify passing rows when complete checks are unavailable', () => {
  const owner = markCompletePRCheckOwner(
    { ...pr, checksStatus: 'neutral', checksSummary: undefined },
    'host-epoch'
  )
  expect(buildPrGateRows({ pr: owner, details: null, checks, checksError: null })[0].tone).toBe(
    'idle'
  )
})
