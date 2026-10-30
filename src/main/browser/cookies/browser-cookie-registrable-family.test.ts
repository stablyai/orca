import { describe, expect, it } from 'vitest'
import { registrableFamily } from './browser-cookie-import-policy'

describe('registrableFamily', () => {
  it.each([
    ['sub.example.com', 'example.com'],
    ['a.b.c.example.co.uk', 'example.co.uk'],
    ['example.com', 'example.com'],
    ['.example.com', 'example.com'],
    ['EXAMPLE.COM', 'example.com'],
    ['user.github.io', 'user.github.io'],
    ['localhost', 'localhost']
  ])('maps %s to %s', (host, expected) => {
    expect(registrableFamily(host)).toBe(expected)
  })

  // Normalize alternate IP spellings before applying public-suffix rules.
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.1', '192.168.1.1'],
    ['127.1', '127.0.0.1'],
    ['2130706433', '127.0.0.1'],
    ['0x7f.1', '127.0.0.1'],
    ['127.0.0.1.', '127.0.0.1'],
    // The URL parser treats a leading zero as octal.
    ['010.0.0.1', '8.0.0.1']
  ])('recognises the IPv4 literal %s as %s', (host, expected) => {
    expect(registrableFamily(host)).toBe(expected)
  })

  it.each([
    ['[::1]', '[::1]'],
    ['[2001:db8::1]', '[2001:db8::1]']
  ])('recognises the IPv6 literal %s', (host, expected) => {
    expect(registrableFamily(host)).toBe(expected)
  })

  it.each([['com'], ['co.uk'], ['github.io']])('returns null for the public suffix %s', (host) => {
    expect(registrableFamily(host)).toBeNull()
  })

  it('returns null for a domain that cannot be normalised', () => {
    expect(registrableFamily('')).toBeNull()
    expect(registrableFamily('http://evil.example/path')).toBeNull()
  })
})
