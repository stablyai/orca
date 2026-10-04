import { describe, expect, it } from 'vitest'
import { readCachedHomeAccounts } from './cached-home-accounts'
import { deepSeekMobileSnapshot } from '../test-support/deepseek-balance-snapshot'

describe('cached Home monetary evidence', () => {
  it('keeps quota but requires fresh owner evidence before painting persisted money', () => {
    const accounts = readCachedHomeAccounts({ host: deepSeekMobileSnapshot() })
    expect(accounts.host?.rateLimits.claude?.session?.usedPercent).toBe(25)
    expect(accounts.host?.rateLimits.deepseek).toBeNull()
    expect(accounts.host?.rateLimits.deepseekAccount).toBeNull()
  })
  it('tolerates malformed cached hosts independently and retains an older host', () => {
    const accounts = readCachedHomeAccounts({
      bad: {},
      old: deepSeekMobileSnapshot({ deepseek: undefined, deepseekAccount: undefined })
    })
    expect(accounts.bad).toBeUndefined()
    expect(accounts.old?.rateLimits.claude?.session?.usedPercent).toBe(25)
    expect(readCachedHomeAccounts(null)).toEqual({})
  })
})
