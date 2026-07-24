import { describe, expect, it } from 'vitest'
import {
  AI_VAULT_SCOPE_CWD_CACHE_KEY_MAX_UTF8_BYTES,
  AI_VAULT_SCOPE_CWD_CACHE_VALUE_MAX_UTF8_BYTES,
  AiVaultScopeCwdCache
} from './session-scope-cwd-cache'

describe('AI Vault scope cwd cache', () => {
  it('rejects keys and values one byte over their UTF-8 limits', () => {
    const cache = new AiVaultScopeCwdCache()
    const exactKey = 'é'.repeat(AI_VAULT_SCOPE_CWD_CACHE_KEY_MAX_UTF8_BYTES / 2)
    const exactValue = 'é'.repeat(AI_VAULT_SCOPE_CWD_CACHE_VALUE_MAX_UTF8_BYTES / 2)

    cache.set(exactKey, exactValue)
    cache.set(`${exactKey}x`, '/overflow-key')
    cache.set('/overflow-value', `${exactValue}x`)

    expect(cache.inspectForTests().keys).toEqual([exactKey])
  })

  it('evicts least-recently-used entries at the aggregate byte boundary', () => {
    const entryBytes = Buffer.byteLength('/a/repo', 'utf8') + Buffer.byteLength('/a', 'utf8') + 128
    const cache = new AiVaultScopeCwdCache({ maxEntries: 3, maxRetainedBytes: entryBytes * 2 })

    cache.set('/a/repo', '/a')
    cache.set('/b/repo', '/b')
    expect(cache.get('/a/repo')).toBe('/a')
    cache.set('/c/repo', '/c')

    expect(cache.inspectForTests().keys).toEqual(['/a/repo', '/c/repo'])
  })
})
