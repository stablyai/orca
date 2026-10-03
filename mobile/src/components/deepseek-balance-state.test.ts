import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from './accounts-snapshot'
import { getDeepSeekBalanceState } from './deepseek-balance-state'
import {
  deepSeekMobileSnapshot,
  MOBILE_DEEPSEEK_ACCOUNT,
  MOBILE_DEEPSEEK_BALANCE,
  MOBILE_DEEPSEEK_LIMITS
} from '../test-support/deepseek-balance-snapshot'

describe('mobile DeepSeek monetary snapshot', () => {
  it('retains both original currencies and string precision independently of quota windows', () => {
    const snapshot = decodeAccountsSnapshot(deepSeekMobileSnapshot())
    expect(getDeepSeekBalanceState(snapshot)).toEqual({
      balance: MOBILE_DEEPSEEK_BALANCE,
      messages: []
    })
    expect(snapshot.rateLimits.deepseek?.monthly).toBeUndefined()
    expect(snapshot.rateLimits.deepseek?.session).toBeNull()
  })
  it.each([
    undefined,
    null,
    { ...MOBILE_DEEPSEEK_ACCOUNT, supported: false },
    { ...MOBILE_DEEPSEEK_ACCOUNT, configured: false },
    { ...MOBILE_DEEPSEEK_ACCOUNT, ownerId: null }
  ])('hides old, unsupported, removed or unowned accounts (%s)', (deepseekAccount) => {
    expect(
      getDeepSeekBalanceState(decodeAccountsSnapshot(deepSeekMobileSnapshot({ deepseekAccount })))
    ).toBeNull()
  })
  it.each([
    {
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: 12, granted_balance: '0', topped_up_balance: '12' }
      ]
    },
    {
      is_available: true,
      balance_infos: [
        { currency: 'EUR', total_balance: '12', granted_balance: '0', topped_up_balance: '12' }
      ]
    },
    { is_available: true, balance_infos: [] }
  ])('isolates malformed monetary rows while preserving healthy Claude data', (balance) => {
    const snapshot = decodeAccountsSnapshot(
      deepSeekMobileSnapshot({ deepseek: { ...MOBILE_DEEPSEEK_LIMITS, balance } })
    )
    expect(snapshot.rateLimits.claude?.session?.usedPercent).toBe(25)
    expect(getDeepSeekBalanceState(snapshot)).toEqual({
      balance: null,
      messages: ['Balance unavailable']
    })
  })
  it('isolates a malformed provider identity or presence field', () => {
    const badProvider = decodeAccountsSnapshot(
      deepSeekMobileSnapshot({ deepseek: { ...MOBILE_DEEPSEEK_LIMITS, provider: 'claude' } })
    )
    expect(badProvider.rateLimits.deepseek).toBeNull()
    expect(badProvider.rateLimits.claude?.session?.usedPercent).toBe(25)
    const badPresence = decodeAccountsSnapshot(
      deepSeekMobileSnapshot({ deepseekAccount: { supported: 'yes' } })
    )
    expect(getDeepSeekBalanceState(badPresence)).toBeNull()
  })
  it('keeps insufficient and stale conditions explicit without manufacturing zero', () => {
    const snapshot = decodeAccountsSnapshot(
      deepSeekMobileSnapshot({
        deepseek: {
          ...MOBILE_DEEPSEEK_LIMITS,
          status: 'error',
          balance: { ...MOBILE_DEEPSEEK_BALANCE, is_available: false }
        }
      })
    )
    expect(getDeepSeekBalanceState(snapshot)).toEqual({
      balance: { ...MOBILE_DEEPSEEK_BALANCE, is_available: false },
      messages: [
        'DeepSeek reports insufficient balance for API calls.',
        'Refresh failed — showing the last balance.'
      ]
    })
  })
  it('shows unavailable or pending for a configured host and strips unexpected credential fields', () => {
    for (const status of ['error', 'fetching']) {
      const snapshot = decodeAccountsSnapshot(
        deepSeekMobileSnapshot({
          deepseek: { ...MOBILE_DEEPSEEK_LIMITS, status, balance: null },
          deepseekAccount: { ...MOBILE_DEEPSEEK_ACCOUNT, apiKey: 'synthetic-secret' }
        })
      )
      expect(getDeepSeekBalanceState(snapshot)?.messages).toEqual([
        status === 'error' ? 'Balance unavailable' : 'Checking balance…'
      ])
      expect(JSON.stringify(snapshot.rateLimits.deepseekAccount)).not.toContain('synthetic-secret')
    }
  })
})
