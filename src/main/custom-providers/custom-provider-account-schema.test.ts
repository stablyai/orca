import { describe, expect, it } from 'vitest'
import { CustomProviderAccount, CustomProviderAccountList } from './custom-provider-account-schema'

function makeRawAccount(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'acc-1',
    displayName: 'Acme',
    enabled: true,
    usageUrl: 'https://example.com/usage',
    mappingMode: 'percent',
    percentPath: 'percent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

describe('CustomProviderAccount displayName validation (#1)', () => {
  it('rejects a whitespace-only display name', () => {
    const result = CustomProviderAccount.safeParse(makeRawAccount({ displayName: '   ' }))
    expect(result.success).toBe(false)
  })

  it('trims a display name with surrounding whitespace instead of persisting it verbatim', () => {
    const result = CustomProviderAccount.safeParse(makeRawAccount({ displayName: '  Acme  ' }))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.displayName).toBe('Acme')
    }
  })

  it('accepts a non-empty trimmed display name', () => {
    const result = CustomProviderAccount.safeParse(makeRawAccount({ displayName: 'Acme' }))
    expect(result.success).toBe(true)
  })
})

describe('CustomProviderAccountList duplicate detection', () => {
  it('still detects duplicate names once whitespace-only names are rejected upstream', () => {
    const result = CustomProviderAccountList.safeParse([
      makeRawAccount({ id: 'a', displayName: 'Acme' }),
      makeRawAccount({ id: 'b', displayName: ' acme ' })
    ])
    expect(result.success).toBe(false)
  })
})
