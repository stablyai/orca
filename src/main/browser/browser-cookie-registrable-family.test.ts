import { describe, expect, it } from 'vitest'
import { registrableFamily } from './browser-cookie-import-policy'

// Why (STA-4300): registrableFamily decides which coordinates a skip-bearing import must leave
// alone. A family computed too narrowly fails to preserve a sibling and the user loses a session,
// so the adversarial host forms are pinned here rather than argued about in review.
describe('registrableFamily', () => {
  it.each([
    ['sub.example.com', 'example.com'],
    ['a.b.c.example.co.uk', 'example.co.uk'],
    ['example.com', 'example.com'],
    // Why: leading dots are cookie-domain syntax, not part of the family.
    ['.example.com', 'example.com'],
    ['EXAMPLE.COM', 'example.com'],
    // Why: a private suffix is its own registrable boundary — user.github.io must not collapse to
    // github.io, or one user's skip would preserve every other user's cookies.
    ['user.github.io', 'user.github.io'],
    // Why: unlisted single-label hosts have no registrable parent; they are their own family.
    ['localhost', 'localhost']
  ])('maps %s to %s', (host, expected) => {
    expect(registrableFamily(host)).toBe(expected)
  })

  // Why: psl treats an IPv4 literal as a dotted DNS name — psl.parse('127.0.0.1').domain is '0.1'.
  // These pass only because the IP check runs on normalizeCookieDomain's canonicalised output.
  // Moving the check before normalisation reintroduces a wrong, destructive family.
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.1', '192.168.1.1'],
    // Chromium accepts all of these spellings of 127.0.0.1; new URL() canonicalises them.
    ['127.1', '127.0.0.1'],
    ['2130706433', '127.0.0.1'],
    ['0x7f.1', '127.0.0.1'],
    ['127.0.0.1.', '127.0.0.1'],
    // Octal, and 8.0.0.1 is the correct reading — psl would have produced '0.1'.
    ['010.0.0.1', '8.0.0.1']
  ])('recognises the IPv4 literal %s as %s', (host, expected) => {
    expect(registrableFamily(host)).toBe(expected)
  })

  // Why: isIP('[::1]') is 0, so the bracketed form needs its own branch. Without it these fall
  // through to psl, which throws, which happens to return the host — right answer, wrong reason,
  // and it stops being right the moment the error branch is touched.
  it.each([
    ['[::1]', '[::1]'],
    ['[2001:db8::1]', '[2001:db8::1]']
  ])('recognises the IPv6 literal %s', (host, expected) => {
    expect(registrableFamily(host)).toBe(expected)
  })

  // Why: a bare public suffix names no family. Returning 'com' here would hand an entire TLD to the
  // preserve set and turn every import under it into a silent no-op.
  it.each([['com'], ['co.uk'], ['github.io']])('returns null for the public suffix %s', (host) => {
    expect(registrableFamily(host)).toBeNull()
  })

  it('returns null for a domain that cannot be normalised', () => {
    expect(registrableFamily('')).toBeNull()
    expect(registrableFamily('http://evil.example/path')).toBeNull()
  })
})
