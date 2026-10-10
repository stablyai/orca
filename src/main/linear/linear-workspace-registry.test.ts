import { afterEach, describe, expect, it } from 'vitest'
import {
  cacheToken,
  getCachedToken,
  recordCredentialError,
  resetCredentialCaches
} from './linear-workspace-registry'

describe('Linear workspace credential caches', () => {
  afterEach(() => resetCredentialCaches())

  it('bounds token and credential-error entries during workspace churn', () => {
    for (let index = 0; index < 132; index += 1) {
      cacheToken(`workspace-${index}`, `token-${index}`)
      recordCredentialError(`workspace-${index}`, `error-${index}`)
    }
    expect(getCachedToken('workspace-0')).toBeUndefined()
    expect(getCachedToken('workspace-131')).toBe('token-131')
  })
})
