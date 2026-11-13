import { describe, expect, it } from 'vitest'
import { parsePlanCatalog } from './plan-catalog-schema'

// Shaped like billing's plansView (cloud/apps/billing src/plans-api.ts).
const team = {
  id: 'team',
  kind: 'self_serve',
  name: 'Team',
  version: 1,
  entitlements: { sandbox_hours_monthly: { value: 60, perSeat: true } },
  features: [
    { id: 'included_hours_per_seat', params: { hours: 60 }, text: '60 sandbox hours per seat' }
  ],
  billing: 'per_seat',
  prices: [
    { interval: 'month', unitAmountCents: 5000, currency: 'usd' },
    { interval: 'year', unitAmountCents: 48000, currency: 'usd' }
  ],
  overage: {
    centsPerHour: 100,
    billedPer: 'minute',
    defaultSpendCapCents: 2500,
    maxSpendCapCents: 500000
  },
  seats: { min: 1, max: 500 },
  warnAtPercent: [75, 90, 100],
  checkout: { available: true, intervals: ['month', 'year'] }
}
const enterprise = {
  id: 'enterprise',
  kind: 'contact_sales',
  name: 'Enterprise',
  version: 1,
  entitlements: {},
  features: [{ id: 'byoc', params: {}, text: 'Run sandboxes in your own cloud' }],
  contactUrl: 'https://orca.dev/enterprise',
  priceLabel: 'Custom'
}

describe('parsePlanCatalog', () => {
  it('reads plans, Stripe prices, features, seats and overage', () => {
    const catalog = parsePlanCatalog({
      schemaVersion: 1,
      catalogVersion: 'c_1',
      plans: [team, enterprise]
    })
    expect(catalog?.catalogVersion).toBe('c_1')
    expect(catalog?.plans[0]).toEqual({
      kind: 'self_serve',
      id: 'team',
      name: 'Team',
      version: 1,
      features: team.features,
      prices: team.prices,
      overage: { centsPerHour: 100, defaultSpendCapCents: 2500, maxSpendCapCents: 500000 },
      seats: { min: 1, max: 500 },
      includedHoursPerSeat: 60,
      checkoutAvailable: true,
      supportUrl: null
    })
    expect(catalog?.plans[1]).toEqual({
      kind: 'contact_sales',
      id: 'enterprise',
      name: 'Enterprise',
      version: 1,
      features: enterprise.features,
      contactUrl: 'https://orca.dev/enterprise',
      priceLabel: 'Custom',
      supportUrl: null
    })
  })

  it('drops a malformed plan, price or feature on its own and keeps unknown kinds', () => {
    const catalog = parsePlanCatalog({
      schemaVersion: 1,
      catalogVersion: 'c_2',
      newField: true,
      plans: [
        {
          ...team,
          prices: [
            team.prices[0],
            { interval: 'week', unitAmountCents: 1, currency: 'usd' },
            { interval: 'year', unitAmountCents: -1, currency: 'usd' }
          ],
          features: [...team.features, { id: 'Bad Id', text: 'x' }]
        },
        { kind: 'self_serve', name: 'No id' },
        { id: 'free', kind: 'free', name: 'Free', version: 1, features: [] },
        'not a plan'
      ]
    })
    expect(catalog?.plans.map((plan) => plan.id)).toEqual(['team', 'free'])
    const first = catalog?.plans[0]
    expect(first && 'prices' in first ? first.prices : null).toEqual([team.prices[0]])
    expect(first?.features).toHaveLength(1)
    expect(catalog?.plans[1]?.kind).toBe('free')
  })

  it('never offers checkout without a price, and refuses a non-v1 body', () => {
    const catalog = parsePlanCatalog({
      schemaVersion: 1,
      catalogVersion: 'c',
      plans: [{ ...team, prices: [] }]
    })
    const plan = catalog?.plans[0]
    expect(plan && 'checkoutAvailable' in plan ? plan.checkoutAvailable : null).toBe(false)
    expect(parsePlanCatalog({ schemaVersion: 2, plans: [] })).toBeNull()
    expect(parsePlanCatalog(null)).toBeNull()
  })

  it('keeps an insecure contact URL out', () => {
    const catalog = parsePlanCatalog({
      schemaVersion: 1,
      catalogVersion: 'c',
      plans: [{ ...enterprise, contactUrl: 'http://x.test' }]
    })
    const plan = catalog?.plans[0]
    expect(plan && 'contactUrl' in plan ? plan.contactUrl : 'missing').toBeNull()
  })

  it('keeps an https supportUrl and drops any other scheme (shell:openUrl opens https only)', () => {
    const read = (supportUrl: unknown) =>
      parsePlanCatalog({
        schemaVersion: 1,
        catalogVersion: 'c',
        plans: [{ ...enterprise, supportUrl }]
      })?.plans[0]?.supportUrl
    expect(read('https://orca.dev/enterprise')).toBe('https://orca.dev/enterprise')
    expect(read('mailto:help@orca.dev')).toBeNull()
    expect(read('javascript:alert(1)')).toBeNull()
    expect(read(undefined)).toBeNull()
  })
})
