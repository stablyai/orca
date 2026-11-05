import { afterEach, expect, it } from 'vitest'
import { buildPrGateRows } from './pr-tab-gates'
import { markCompletePRCheckOwner } from '../../../../src/shared/github/complete-pr-check-owner'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { activateMobileUiLocale, mobileI18n } from '../../i18n/mobile-i18n'
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
it.each([
  ['en', '1 check failing'],
  ['es', '1 comprobación fallida']
] as const)(
  'keeps the whole PR blocking with partial passing rows in %s',
  async (locale, title) => {
    mobileI18n.addResourceBundle(
      'es',
      'translation',
      {
        pullRequest: {
          gates: {
            checksFailing_one: '{{count}} comprobación fallida',
            checksFailing_other: '{{count}} comprobaciones fallidas'
          }
        }
      },
      true,
      true
    )
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
    ).toMatchObject({ key: 'checks', tone: 'blocking', title, subtitle: null })
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

it.each([
  ['en', 'Cancelled'],
  ['es', 'Cancelado']
] as const)('keeps a cancelled owner truthful without detail rows in %s', async (locale, title) => {
  mobileI18n.addResourceBundle(
    'es',
    'translation',
    { pullRequest: { checkStatus: { cancelled: 'Cancelado' } } },
    true,
    true
  )
  await activateMobileUiLocale(locale)
  const owner = markCompletePRCheckOwner(
    {
      ...pr,
      checksSummary: {
        state: 'failure',
        total: 1,
        passed: 0,
        failed: 1,
        cancelled: 1,
        pending: 0,
        neutral: 0
      }
    },
    'host-epoch'
  )
  for (const checksError of [null, 'Rows unavailable']) {
    expect(buildPrGateRows({ pr: owner, details: null, checks: [], checksError })[0]).toMatchObject(
      { title, tone: 'idle', subtitle: null }
    )
  }
  expect(
    buildPrGateRows({
      pr: owner,
      details: null,
      checks: [{ name: 'Build', status: 'completed', conclusion: 'cancelled', url: null }],
      checksError: null
    })[0].subtitle
  ).toBeTruthy()
  expect(
    buildPrGateRows({ pr, details: null, checks: [], checksError: null })[0].subtitle
  ).toBeNull()
})
