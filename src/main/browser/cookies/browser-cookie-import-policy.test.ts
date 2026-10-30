import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Cookie } from 'electron'
import {
  identitiesFromClearCookies,
  removeTransplantableCookies
} from './browser-cookie-import-clear'
import {
  importedDomainScope,
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain
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

  // YouTube reissues imported sessions, so the Google exemption must not cover it.
  it('deliberately leaves youtube.com transplantable', () => {
    expect(isNonTransplantableCookieDomain('.youtube.com')).toBe(false)
    expect(isNonTransplantableCookieDomain('accounts.youtube.com')).toBe(false)
  })
})

type CookieClearMocks = {
  get: Mock
  remove: Mock
  set: Mock
}

describe('removeTransplantableCookies', () => {
  function clearSession(cookies: Cookie[], overrides: Partial<CookieClearMocks> = {}) {
    const store = {
      get: vi.fn().mockResolvedValue(cookies),
      remove: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      ...overrides
    }
    const restoreClearIdentities = vi.fn().mockResolvedValue(undefined)
    const snapshotClearIdentities = vi.fn(
      async (items: Parameters<typeof identitiesFromClearCookies>[0]) =>
        identitiesFromClearCookies(items)
    )
    return {
      session: {
        cookies: store,
        snapshotClearIdentities,
        restoreClearIdentities
      },
      get: store.get,
      remove: store.remove,
      set: store.set,
      snapshotClearIdentities,
      restoreClearIdentities
    }
  }

  // Keep google.com in scope so only the non-transplantable exemption can protect it.
  it('removes the imported coordinates one by one and leaves the Google family alone', async () => {
    const { session, remove, set } = clearSession([
      cookie('.google.com', 'SID'),
      cookie('accounts.google.com', 'ACCOUNT'),
      cookie('.example.com', 'session'),
      cookie('other.test', 'tracker', '/scoped')
    ])

    await removeTransplantableCookies(
      session,
      new Set(),
      importedDomainScope(['google.com', 'example.com', 'other.test'])
    )

    expect(remove.mock.calls).toEqual([
      ['https://example.com/', 'session'],
      ['https://other.test/scoped', 'tracker']
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('removes every in-scope coordinate when the jar holds nothing to preserve', async () => {
    const { session, remove, set } = clearSession([
      cookie('.example.com', 'session'),
      cookie('other.test', 'tracker', '/scoped'),
      cookie('notgoogle.com', 'lookalike')
    ])

    await removeTransplantableCookies(
      session,
      new Set(),
      importedDomainScope(['example.com', 'other.test', 'notgoogle.com'])
    )

    expect(remove.mock.calls).toEqual([
      ['https://example.com/', 'session'],
      ['https://other.test/scoped', 'tracker'],
      ['https://notgoogle.com/', 'lookalike']
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('touches nothing when the jar is already empty', async () => {
    const { session, remove, snapshotClearIdentities } = clearSession([])

    await removeTransplantableCookies(session, new Set(), importedDomainScope(['example.com']))

    expect(snapshotClearIdentities).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not attach or remove when the jar contains only excluded cookies', async () => {
    const { session, snapshotClearIdentities, remove } = clearSession([
      cookie('.google.com', 'SID'),
      cookie('accounts.google.com', 'ACCOUNT')
    ])

    await removeTransplantableCookies(session, new Set(), importedDomainScope(['google.com']))

    expect(snapshotClearIdentities).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('skips a cookie that cannot be represented for rollback without mutating anything', async () => {
    const { session, remove, snapshotClearIdentities, restoreClearIdentities } = clearSession([
      { ...cookie('.example.com', 'session'), domain: '' }
    ])

    await expect(
      removeTransplantableCookies(session, new Set(), importedDomainScope(['example.com']))
    ).resolves.toBeUndefined()

    expect(snapshotClearIdentities).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(restoreClearIdentities).not.toHaveBeenCalled()
  })

  it('removes only the frozen pre-clear plan and never re-reads the jar', async () => {
    const beforeAttempt = [
      cookie('.removed.test', 'gone-before-clear'),
      cookie('.survivor.test', 'survived')
    ]
    const get = vi
      .fn()
      .mockResolvedValue([
        cookie('.google.com', 'SID'),
        cookie('.survivor.test', 'survived'),
        cookie('.arrived.test', 'arrived-during-clear')
      ])
      .mockResolvedValueOnce(beforeAttempt)
    const { session, remove } = clearSession(beforeAttempt, { get })

    await removeTransplantableCookies(
      session,
      new Set(),
      // Keep arrived.test in scope to test the frozen plan.
      importedDomainScope(['removed.test', 'survivor.test', 'arrived.test', 'google.com'])
    )

    expect(get).toHaveBeenCalledOnce()
    expect(remove.mock.calls).toEqual([
      ['https://removed.test/', 'gone-before-clear'],
      ['https://survivor.test/', 'survived']
    ])
  })

  it('never touches a cookie that arrives after the removal plan is frozen', async () => {
    const beforeAttempt = [
      cookie('.example.com', 'first', '/one'),
      cookie('.example.com', 'second', '/two')
    ]
    const get = vi
      .fn()
      .mockResolvedValue([...beforeAttempt, cookie('.arrived.test', 'fresh-login')])
      .mockResolvedValueOnce(beforeAttempt)
    const { session, remove, restoreClearIdentities } = clearSession(beforeAttempt, {
      get,
      remove: vi.fn().mockImplementation(async (_url: string, name: string) => {
        if (name === 'second') {
          throw new Error('store unavailable')
        }
      })
    })

    await expect(
      removeTransplantableCookies(
        session,
        new Set(),
        importedDomainScope(['example.com', 'arrived.test'])
      )
    ).rejects.toThrow('existing cookies were restored')

    expect(remove.mock.calls).toEqual([
      ['https://example.com/one', 'first'],
      ['https://example.com/two', 'second']
    ])
    expect(restoreClearIdentities).toHaveBeenCalledOnce()
    const restored = restoreClearIdentities.mock.calls[0][0].map(
      (identity: { name: string }) => identity.name
    )
    expect([...restored].sort()).toEqual(['first', 'second'])
  })

  it('preserves Google cookies on the per-coordinate removal path', async () => {
    const { session, remove, set } = clearSession([
      cookie('.google.com', 'SID'),
      cookie('accounts.google.com', 'ACCOUNT'),
      cookie('.example.com', 'session')
    ])

    await removeTransplantableCookies(
      session,
      new Set(),
      importedDomainScope(['google.com', 'example.com'])
    )

    expect(remove.mock.calls).toEqual([['https://example.com/', 'session']])
    expect(set).not.toHaveBeenCalled()
  })

  it('restores removed cookies through captured identities when another removal fails', async () => {
    const { session, remove, set, restoreClearIdentities } = clearSession(
      [
        cookie('.google.com', 'SID'),
        cookie('.example.com', 'first', '/one'),
        cookie('.example.com', 'second', '/two'),
        cookie('.example.com', 'third', '/three')
      ],
      {
        remove: vi.fn().mockImplementation(async (_url: string, name: string) => {
          if (name === 'second') {
            throw new Error('store unavailable')
          }
        })
      }
    )

    await expect(
      removeTransplantableCookies(
        session,
        new Set(),
        importedDomainScope(['google.com', 'example.com'])
      )
    ).rejects.toThrow('existing cookies were restored')
    expect(remove).toHaveBeenCalledTimes(3)
    expect(set).not.toHaveBeenCalled()
    expect(restoreClearIdentities).toHaveBeenCalledOnce()
    expect(
      restoreClearIdentities.mock.calls[0][0].map((identity: { name: string }) => identity.name)
    ).toEqual(expect.arrayContaining(['first', 'second', 'third']))
  })

  it('bounds parallel removals so large cookie jars do not clear serially or fan out', async () => {
    let releaseRemovals: (() => void) | undefined
    const removalsReleased = new Promise<void>((resolve) => {
      releaseRemovals = resolve
    })
    let active = 0
    let maxActive = 0
    const { session, remove, set } = clearSession(
      [
        cookie('.google.com', 'SID'),
        ...Array.from({ length: 12 }, (_, index) => cookie('.example.com', `${index}`))
      ],
      {
        remove: vi.fn().mockImplementation(async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await removalsReleased
          active--
        })
      }
    )

    const clearing = removeTransplantableCookies(
      session,
      new Set(),
      importedDomainScope(['google.com', 'example.com'])
    )
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(8))
    expect(maxActive).toBe(8)
    releaseRemovals?.()
    await clearing

    expect(remove).toHaveBeenCalledTimes(12)
    expect(set).not.toHaveBeenCalled()
  })

  it('serializes cookies that share Electron removal coordinates', async () => {
    let releaseFirst: (() => void) | undefined
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { session, remove } = clearSession(
      [
        cookie('.google.com', 'SID'),
        cookie('.example.com', 'session'),
        { ...cookie('example.com', 'session'), hostOnly: true }
      ],
      {
        remove: vi
          .fn()
          .mockImplementationOnce(() => firstReleased)
          .mockResolvedValueOnce(undefined)
      }
    )

    const clearing = removeTransplantableCookies(
      session,
      new Set(),
      importedDomainScope(['google.com', 'example.com'])
    )
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    releaseFirst?.()
    await clearing

    expect(remove.mock.calls).toEqual([
      ['https://example.com/', 'session'],
      ['https://example.com/', 'session']
    ])
  })
})
