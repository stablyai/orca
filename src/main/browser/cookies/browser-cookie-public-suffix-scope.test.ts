import { describe, expect, it } from 'vitest'
import { normalizeCookieImportDomain } from './browser-cookie-import-policy'

// Suffix-list changes can widen removal scopes and destroy unrelated sessions.
describe('registrable family across public-suffix sections', () => {
  it('rejects a bare suffix as an import domain but keeps real hosts', () => {
    expect(normalizeCookieImportDomain('co.uk')).toBeNull()
    expect(normalizeCookieImportDomain('api.br')).toBeNull()
    expect(normalizeCookieImportDomain('.example.com')).toBe('example.com')
    expect(normalizeCookieImportDomain('foo.github.io')).toBe('foo.github.io')
  })
})
