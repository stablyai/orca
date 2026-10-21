import { describe, expect, it } from 'vitest'
import {
  domainIsInImportedScope,
  importedDomainScope,
  normalizeCookieImportDomain,
  registrableFamily
} from './browser-cookie-import-policy'

// Why this file exists: the public-suffix engine decides which cookies share a removal scope, so a
// library swap silently re-partitions the jar. These cases pin the boundaries that moved (or had to
// be held) when this moved off `psl`.
describe('registrable family across public-suffix sections', () => {
  it('keeps each PRIVATE-section tenant in its own family', () => {
    // psl and tldts disagree here unless allowPrivateDomains is set; without it every
    // *.github.io tenant collapses into one family and a replace-mode import clears siblings.
    expect(registrableFamily('foo.github.io')).toBe('foo.github.io')
    expect(registrableFamily('bar.github.io')).toBe('bar.github.io')
    expect(registrableFamily('bar.s3.amazonaws.com')).toBe('bar.s3.amazonaws.com')
    expect(registrableFamily('foo.vercel.app')).toBe('foo.vercel.app')
  })

  it('refuses to name a bare public suffix as a family', () => {
    expect(registrableFamily('com')).toBeNull()
    expect(registrableFamily('co.uk')).toBeNull()
    expect(registrableFamily('github.io')).toBeNull()
    // Absent from psl 1.15.0's 2024 snapshot; naming it a family would preserve a whole suffix.
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

// Why: `.local` is absent from the PSL, and the two libraries disagreed about what that means. psl
// returned an all-null parse, so every `*.orca.local` host was its own family; tldts applies the
// default single-label rule and stops at `orca.local`, which is what Chromium treats as registrable.
// The widening is deliberate, so it is pinned here rather than left to the next library bump.
describe('unlisted .local suffix', () => {
  it('stops at the two-label boundary', () => {
    expect(registrableFamily('app.orca.local')).toBe('orca.local')
    expect(registrableFamily('orca.local')).toBe('orca.local')
  })

  // The consequence of the boundary move: a replace-mode import of one host now also clears
  // non-host-only cookies scoped to `.orca.local`, which every sibling `*.orca.local` host shares.
  it('pulls the shared parent into the removal scope', () => {
    const scope = importedDomainScope(['app.orca.local'])

    expect(domainIsInImportedScope(scope, 'orca.local', false)).toBe(true)
    expect(domainIsInImportedScope(scope, 'orca.local', true)).toBe(false)
  })
})

// Why: psl's 2024 snapshot carried `compute.amazonaws.com` as a literal PRIVATE suffix; the current
// list only has the `*.compute.amazonaws.com` wildcard, so the bare host is an ordinary ICANN domain
// now. That moves a real host shape from "no family" to `amazonaws.com`.
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
