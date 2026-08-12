import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Cookie } from 'electron'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  NON_TRANSPLANTABLE_HOST_KEY_SQL,
  normalizeCookieDomain,
  removeAllCookiesExcept,
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

describe('isNonTransplantableCookieDomain', () => {
  it('covers the whole google.com registrable family', () => {
    expect(isNonTransplantableCookieDomain('google.com')).toBe(true)
    expect(isNonTransplantableCookieDomain('.google.com')).toBe(true)
    expect(isNonTransplantableCookieDomain('accounts.google.com')).toBe(true)
    expect(isNonTransplantableCookieDomain('MAIL.Google.Com')).toBe(true)
  })

  it('does not match lookalikes or unrelated sites', () => {
    expect(isNonTransplantableCookieDomain('withgoogle.com')).toBe(false)
    expect(isNonTransplantableCookieDomain('google.com.evil.example')).toBe(false)
    expect(isNonTransplantableCookieDomain('notgoogle.com')).toBe(false)
    expect(isNonTransplantableCookieDomain('linear.app')).toBe(false)
    expect(isNonTransplantableCookieDomain('')).toBe(false)
  })

  // Why: youtube.com re-issues its cookies from a transplanted session, so excluding it would
  // drop imports users asked for. Locking it in keeps a future "just add it too" edit honest.
  it('deliberately leaves youtube.com transplantable', () => {
    expect(isNonTransplantableCookieDomain('.youtube.com')).toBe(false)
    expect(isNonTransplantableCookieDomain('accounts.youtube.com')).toBe(false)
  })
})

describe('NON_TRANSPLANTABLE_HOST_KEY_SQL', () => {
  it('selects the google.com family and nothing that merely looks like it', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE cookies (host_key TEXT)')
    for (const hostKey of [
      'google.com',
      '.google.com',
      'accounts.google.com',
      'withgoogle.com',
      'google.com.evil.example',
      '.youtube.com',
      '.linear.app'
    ]) {
      db.prepare('INSERT INTO cookies (host_key) VALUES (?)').run(hostKey)
    }

    const matched = db
      .prepare(
        `SELECT host_key FROM cookies WHERE ${NON_TRANSPLANTABLE_HOST_KEY_SQL} ORDER BY host_key`
      )
      .all() as { host_key: string }[]
    db.close()

    expect(matched.map((row) => row.host_key)).toEqual([
      '.google.com',
      'accounts.google.com',
      'google.com'
    ])
  })
})

describe('removeAllCookiesExcept', () => {
  it('removes only the cookies the predicate does not exclude', async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        cookie('.google.com', 'SID'),
        cookie('.example.com', 'session'),
        cookie('other.test', 'tracker', '/scoped')
      ])
    const remove = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockResolvedValue(undefined)

    await removeAllCookiesExcept({ get, remove, set }, (c) => c.domain === '.google.com')

    expect(remove.mock.calls).toEqual([
      ['https://example.com/', 'session'],
      ['https://other.test/scoped', 'tracker']
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('restores every successfully removed cookie when another removal fails', async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        cookie('.example.com', 'first', '/one'),
        cookie('.example.com', 'second', '/two'),
        cookie('.example.com', 'third', '/three')
      ])
    const remove = vi.fn().mockImplementation(async (_url: string, name: string) => {
      if (name === 'second') {
        throw new Error('store unavailable')
      }
    })
    const set = vi.fn().mockResolvedValue(undefined)

    await expect(removeAllCookiesExcept({ get, remove, set }, () => false)).rejects.toThrow(
      'Could not clear existing cookies'
    )
    expect(remove).toHaveBeenCalledTimes(3)
    expect(set.mock.calls.map(([details]) => details.name)).toEqual(['first', 'third'])
  })

  it('bounds parallel removals so large cookie jars do not clear serially or fan out', async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 12 }, (_, index) => cookie('.example.com', `${index}`))
      )
    let releaseRemovals: (() => void) | undefined
    const removalsReleased = new Promise<void>((resolve) => {
      releaseRemovals = resolve
    })
    let active = 0
    let maxActive = 0
    const remove = vi.fn().mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await removalsReleased
      active--
    })
    const set = vi.fn().mockResolvedValue(undefined)

    const clearing = removeAllCookiesExcept({ get, remove, set }, () => false)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(8))
    expect(maxActive).toBe(8)
    releaseRemovals?.()
    await clearing

    expect(remove).toHaveBeenCalledTimes(12)
    expect(set).not.toHaveBeenCalled()
  })

  it('serializes cookies that share Electron removal coordinates', async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        cookie('.example.com', 'session'),
        { ...cookie('example.com', 'session'), hostOnly: true }
      ])
    let releaseFirst: (() => void) | undefined
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const remove = vi
      .fn()
      .mockImplementationOnce(() => firstReleased)
      .mockResolvedValueOnce(undefined)
    const set = vi.fn().mockResolvedValue(undefined)

    const clearing = removeAllCookiesExcept({ get, remove, set }, () => false)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    releaseFirst?.()
    await clearing

    expect(remove.mock.calls).toEqual([
      ['https://example.com/', 'session'],
      ['https://example.com/', 'session']
    ])
  })
})
