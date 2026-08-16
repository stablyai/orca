import { describe, expect, it } from 'vitest'
import { parseSubscriptionFromPageText, parseZenBalanceUsd } from './opencode-go-page-scraper'

describe('parseZenBalanceUsd', () => {
  it('parses a scaled balance from a React Flight billing object', () => {
    const text = '($R=>$R[0]=$R[1]={customerID:"cus_test",balance:$R[2]=2375000000,reload:!1})'
    expect(parseZenBalanceUsd(text)).toBe(23.75)
  })

  it('ignores balances when billing is disabled (null customerID)', () => {
    const text = '$R[0]={customerID:null,balance:0,reload:!1}'
    expect(parseZenBalanceUsd(text)).toBeNull()
  })

  it('ignores unrelated balance metadata with no customerID or amount', () => {
    const text = '$R[0]={balanceEnabled:!0,balanceUpdatedAt:1800000000}'
    expect(parseZenBalanceUsd(text)).toBeNull()
  })

  it('keeps the balance scoped to the billing record', () => {
    const text = [
      '$R[0]={customerID:"cus_test",reload:!1}',
      '$R[1]={metrics:{balance:4200000000}}'
    ].join('')
    expect(parseZenBalanceUsd(text)).toBeNull()
  })

  it('skips nested balances before the billing record balance', () => {
    const text =
      '$R[0]={customerID:"cus_test",metrics:{balance:9900000000},balance:1250000000,reload:!1}'
    expect(parseZenBalanceUsd(text)).toBe(12.5)
  })

  it('surfaces granted credit without requiring a payment customer', () => {
    const text = '$R[0]={customerID:null,balance:500000000,reload:!1,reloadAmount:2000000000}'
    expect(parseZenBalanceUsd(text)).toBe(5)
  })

  it('does not infer a balance from human-readable page copy', () => {
    expect(parseZenBalanceUsd('<h2>Current balance $1,234.56</h2>')).toBeNull()
  })

  it('returns null when no balance is present', () => {
    expect(parseZenBalanceUsd('<html><body>no billing here</body></html>')).toBeNull()
  })

  it('guards against oversized payloads', () => {
    expect(parseZenBalanceUsd('x'.repeat(10_000_001))).toBeNull()
  })
})

describe('parseSubscriptionFromPageText', () => {
  it.each([
    ['!0', true],
    ['true', true],
    ['!1', false],
    ['false', false]
  ])('parses useBalance %s from the subscription record', (wireValue, expected) => {
    const text = `$R[0]={note:"brace } stays data",useBalance:${wireValue},rollingUsage:$R[1]={usagePercent:20,resetInSec:60},weeklyUsage:$R[2]={usagePercent:30,resetInSec:120},monthlyUsage:null}`
    expect(parseSubscriptionFromPageText(text)).toMatchObject({
      rollingUsagePercent: 20,
      weeklyUsagePercent: 30,
      useBalance: expected
    })
  })

  it('does not borrow useBalance from an unrelated object', () => {
    const text =
      '$R[0]={useBalance:!0}$R[1]={rollingUsage:$R[2]={usagePercent:20,resetInSec:60},weeklyUsage:$R[3]={usagePercent:30,resetInSec:120}}'
    expect(parseSubscriptionFromPageText(text)).toMatchObject({ useBalance: null })
  })
})
