import { describe, expect, it } from 'vitest'
import {
  domainIsInImportedScope,
  importedDomainScope,
  normalizeCookieImportDomain,
  registrableFamily
} from './browser-cookie-import-policy'

// Suffix-list changes can widen removal scopes and destroy unrelated sessions.
describe('registrable family across public-suffix sections', () => {
  it('keeps each PRIVATE-section tenant in its own family', () => {
    expect(registrableFamily('foo.github.io')).toBe('foo.github.io')
    expect(registrableFamily('bar.github.io')).toBe('bar.github.io')
    expect(registrableFamily('bar.s3.amazonaws.com')).toBe('bar.s3.amazonaws.com')
    expect(registrableFamily('foo.vercel.app')).toBe('foo.vercel.app')
  })

  it('refuses to name a bare public suffix as a family', () => {
    expect(registrableFamily('com')).toBeNull()
    expect(registrableFamily('co.uk')).toBeNull()
    expect(registrableFamily('github.io')).toBeNull()
    expect(registrableFamily('api.br')).toBeNull()
    expect(registrableFamily('seg.ar')).toBeNull()
  })

  it('resolves ICANN suffixes to the registrable domain', () => {
    expect(registrableFamily('a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableFamily('www.example.com')).toBe('example.com')
    expect(registrableFamily('foo.example.api.br')).toBe('example.api.br')
  })

  it('returns the canonicalised address for every IP spelling', () => {
    expect(registrableFamily('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableFamily('127.1')).toBe('127.0.0.1')
    expect(registrableFamily('2130706433')).toBe('127.0.0.1')
    expect(registrableFamily('[::1]')).toBe('[::1]')
  })

  it('treats an unlisted suffix as its own boundary', () => {
    expect(registrableFamily('example.notaruleatall')).toBe('example.notaruleatall')
  })

  it('rejects a bare suffix as an import domain but keeps real hosts', () => {
    expect(normalizeCookieImportDomain('co.uk')).toBeNull()
    expect(normalizeCookieImportDomain('api.br')).toBeNull()
    expect(normalizeCookieImportDomain('.example.com')).toBe('example.com')
    expect(normalizeCookieImportDomain('foo.github.io')).toBe('foo.github.io')
  })
})

// Unlisted .local uses a two-label family boundary.
describe('unlisted .local suffix', () => {
  it('stops at the two-label boundary', () => {
    expect(registrableFamily('app.orca.local')).toBe('orca.local')
    expect(registrableFamily('orca.local')).toBe('orca.local')
  })

  it('pulls the shared parent into the removal scope', () => {
    const scope = importedDomainScope(['app.orca.local'])

    expect(domainIsInImportedScope(scope, 'orca.local', false)).toBe(true)
    expect(domainIsInImportedScope(scope, 'orca.local', true)).toBe(false)
  })
})

// Only *.compute.amazonaws.com is a suffix; the bare host belongs to amazonaws.com.
describe('suffix entries that changed shape upstream', () => {
  it('reads bare compute.amazonaws.com as a registrable domain', () => {
    expect(registrableFamily('compute.amazonaws.com')).toBe('amazonaws.com')
    expect(normalizeCookieImportDomain('compute.amazonaws.com')).toBe('compute.amazonaws.com')
  })

  it('still refuses the wildcard child and the sibling private suffix', () => {
    expect(registrableFamily('foo.compute.amazonaws.com')).toBeNull()
    expect(registrableFamily('s3.amazonaws.com')).toBeNull()
  })
})
