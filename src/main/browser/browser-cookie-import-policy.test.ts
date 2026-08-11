import { describe, expect, it, vi } from 'vitest'
import type { Cookie } from 'electron'
import {
  isGoogleSourceBoundCookie,
  normalizeCookieDomain,
  replaceCookiesForImportedDomains
} from './browser-cookie-import-policy'

function cookie(domain: string, name: string, path = '/', secure = true): Cookie {
  return {
    domain,
    name,
    path,
    secure,
    sameSite: 'unspecified',
    value: 'secret'
  }
}

describe('isGoogleSourceBoundCookie', () => {
  it('matches the allowlisted names only on google.com and its subdomains', () => {
    expect(isGoogleSourceBoundCookie('SIDCC', '.google.com')).toBe(true)
    expect(isGoogleSourceBoundCookie('AEC', 'accounts.google.com')).toBe(true)
    expect(isGoogleSourceBoundCookie('__Secure-STRP', '.accounts.google.com')).toBe(true)
    expect(isGoogleSourceBoundCookie('SIDCC', '.notgoogle.com')).toBe(false)
    expect(isGoogleSourceBoundCookie('SIDCC', '.google.com.evil.example')).toBe(false)
    expect(isGoogleSourceBoundCookie('SID', '.google.com')).toBe(false)
  })

  it('normalizes leading dots, case, and international domains consistently', () => {
    expect(normalizeCookieDomain('..Accounts.Google.Com')).toBe('accounts.google.com')
    expect(normalizeCookieDomain('münich.example')).toBe('xn--mnich-kva.example')
    expect(normalizeCookieDomain('')).toBeNull()
  })

  it('rejects URL syntax that could normalize an invalid cookie scope to another domain', () => {
    expect(normalizeCookieDomain('example.com/path')).toBeNull()
    expect(normalizeCookieDomain('user@example.com')).toBeNull()
    expect(normalizeCookieDomain('example.com:443')).toBeNull()
    expect(normalizeCookieDomain('%65xample.com')).toBeNull()
    expect(isGoogleSourceBoundCookie('SIDCC', 'user@google.com')).toBe(false)
  })
})

describe('replaceCookiesForImportedDomains', () => {
  it('removes parent, exact, and child-domain cookies while preserving unrelated sites', async () => {
    const existing = [
      cookie('.google.com', 'parent'),
      { ...cookie('google.com', 'host-only-parent'), hostOnly: true },
      cookie('.accounts.google.com', 'exact', '/signin'),
      cookie('.child.accounts.google.com', 'child', '/nested', false),
      cookie('.google.com.evil.example', 'suffix-confusion'),
      cookie('.example.com', 'unrelated')
    ]
    const get = vi.fn().mockResolvedValue(existing)
    const remove = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)

    const removed = await replaceCookiesForImportedDomains({ get, remove, set }, [
      'accounts.google.com'
    ])

    expect(removed).toHaveLength(3)
    expect(get).toHaveBeenCalledWith({})
    expect(remove.mock.calls).toEqual([
      ['https://google.com/', 'parent'],
      ['https://accounts.google.com/signin', 'exact'],
      ['http://child.accounts.google.com/nested', 'child']
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('does not replace a private-suffix host cookie for a tenant import', async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        { ...cookie('github.io', 'host-only-suffix'), hostOnly: true },
        cookie('.user.github.io', 'tenant')
      ])
    const remove = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)

    const removed = await replaceCookiesForImportedDomains({ get, remove, set }, ['user.github.io'])

    expect(removed.map(({ name }) => name)).toEqual(['tenant'])
    expect(remove).toHaveBeenCalledWith('https://user.github.io/', 'tenant')
  })

  it('does not read or mutate the store when no valid domain scope exists', async () => {
    const get = vi.fn()
    const remove = vi.fn()
    const set = vi.fn()

    await expect(
      replaceCookiesForImportedDomains({ get, remove, set }, [
        '',
        '...',
        'com',
        'co.uk',
        'github.io'
      ])
    ).resolves.toEqual([])
    expect(get).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps single-label intranet scopes from selecting descendant hosts', async () => {
    const get = vi
      .fn()
      .mockResolvedValue([cookie('local', 'exact'), cookie('.service.local', 'descendant')])
    const remove = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)

    const removed = await replaceCookiesForImportedDomains({ get, remove, set }, ['local'])

    expect(removed.map(({ name }) => name)).toEqual(['exact'])
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('https://local/', 'exact')
  })

  it('restores cookies removed before a later removal fails', async () => {
    const existing = [
      cookie('.example.com', 'first', '/one'),
      cookie('.example.com', 'second', '/two')
    ]
    const get = vi.fn().mockResolvedValue(existing)
    const remove = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cookie store unavailable'))
    const set = vi.fn().mockResolvedValue(undefined)

    await expect(
      replaceCookiesForImportedDomains({ get, remove, set }, ['example.com'])
    ).rejects.toThrow('cookie store unavailable')
    expect(set).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledWith({
      url: 'https://example.com/one',
      name: 'first',
      value: 'secret',
      domain: '.example.com',
      path: '/one',
      secure: true,
      httpOnly: undefined,
      sameSite: 'unspecified'
    })
  })
})
