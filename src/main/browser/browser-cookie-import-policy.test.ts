import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Cookie } from 'electron'
import {
  identitiesFromClearCookies,
  removeTransplantableCookies,
  type CookieClearIdentity
} from './browser-cookie-import-clear'
import {
  importedDomainScope,
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
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

// Why: mirrors what openCookieClearStore returns — get/remove plus the CDP identity pair, and
// deliberately no 'set', so a partition-dropping reconstruction cannot be written against it.
function replaceStore(
  existing: Cookie[],
  overrides: {
    remove?: Mock
    snapshot?: Mock
    restore?: Mock
  } = {}
) {
  const get = vi.fn().mockResolvedValue(existing)
  const remove = overrides.remove ?? vi.fn().mockResolvedValue(undefined)
  const snapshotClearIdentities =
    overrides.snapshot ??
    vi
      .fn()
      .mockImplementation(async (cookies: readonly { cookie: Cookie; url: string }[]) =>
        identitiesFromClearCookies(cookies)
      )
  const restoreClearIdentities = overrides.restore ?? vi.fn().mockResolvedValue(undefined)
  return { get, remove, snapshotClearIdentities, restoreClearIdentities }
}

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
    const store = replaceStore(existing)

    const { removed } = await replaceCookiesForImportedDomains(store, ['accounts.google.com'])

    expect(removed).toHaveLength(3)
    expect(store.get).toHaveBeenCalledWith({})
    expect(store.remove.mock.calls).toEqual([
      ['https://google.com/', 'parent'],
      ['https://accounts.google.com/signin', 'exact'],
      ['http://child.accounts.google.com/nested', 'child']
    ])
    // Why: the snapshot must cover the whole removal plan before the first removal runs.
    expect(store.snapshotClearIdentities).toHaveBeenCalledOnce()
    expect(
      store.snapshotClearIdentities.mock.calls[0]?.[0].map(
        ({ cookie: entry }: { cookie: Cookie }) => entry.name
      )
    ).toEqual(['parent', 'exact', 'child'])
    expect(store.restoreClearIdentities).not.toHaveBeenCalled()
  })

  it('does not replace a private-suffix host cookie for a tenant import', async () => {
    const store = replaceStore([
      { ...cookie('github.io', 'host-only-suffix'), hostOnly: true },
      cookie('.user.github.io', 'tenant')
    ])

    const { removed } = await replaceCookiesForImportedDomains(store, ['user.github.io'])

    expect(removed.map(({ name }) => name)).toEqual(['tenant'])
    expect(store.remove).toHaveBeenCalledWith('https://user.github.io/', 'tenant')
  })

  it('does not read or mutate the store when no valid domain scope exists', async () => {
    const store = replaceStore([])

    await expect(
      replaceCookiesForImportedDomains(store, ['', '...', 'com', 'co.uk', 'github.io'])
    ).resolves.toEqual({ removed: [], identities: [] })
    expect(store.get).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
    expect(store.snapshotClearIdentities).not.toHaveBeenCalled()
    expect(store.restoreClearIdentities).not.toHaveBeenCalled()
  })

  it('keeps single-label intranet scopes from selecting descendant hosts', async () => {
    const store = replaceStore([cookie('local', 'exact'), cookie('.service.local', 'descendant')])

    const { removed } = await replaceCookiesForImportedDomains(store, ['local'])

    expect(removed.map(({ name }) => name)).toEqual(['exact'])
    expect(store.remove).toHaveBeenCalledOnce()
    expect(store.remove).toHaveBeenCalledWith('https://local/', 'exact')
  })

  // Why (STA-4097): cookies.get strips partitionKey and cookies.set ignores it, so a rollback
  // that rebuilds cookies through the Electron API silently downgrades CHIPS cookies. The undo
  // has to travel back through the CDP identities that actually carry the partition.
  it('restores removed cookies through CDP identities, keeping partition identity', async () => {
    const existing = [
      cookie('.example.com', 'first', '/one'),
      cookie('.example.com', 'second', '/two')
    ]
    const partitionKey = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
    const snapshot = vi
      .fn()
      .mockImplementation(async (cookies: readonly { cookie: Cookie; url: string }[]) =>
        identitiesFromClearCookies(cookies).map((identity) =>
          identity.name === 'first' ? { ...identity, partitionKey } : identity
        )
      )
    const remove = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cookie store unavailable'))
    const store = replaceStore(existing, { remove, snapshot })

    await expect(replaceCookiesForImportedDomains(store, ['example.com'])).rejects.toThrow(
      'cookie store unavailable'
    )

    expect(store.restoreClearIdentities).toHaveBeenCalledOnce()
    const restored = store.restoreClearIdentities.mock.calls[0]?.[0] as CookieClearIdentity[]
    // Why: the failing coordinate is restored too — a rejected remove cannot prove it survived.
    expect(restored.map(({ name }) => name)).toEqual(['second', 'first'])
    expect(restored.find(({ name }) => name === 'first')?.partitionKey).toEqual(partitionKey)
    expect(restored.find(({ name }) => name === 'first')?.url).toBe('https://example.com/one')
  })

  it('aborts without removing anything when the snapshot cannot cover the removal plan', async () => {
    const existing = [
      cookie('.example.com', 'first', '/one'),
      cookie('.example.com', 'second', '/two')
    ]
    const snapshot = vi
      .fn()
      .mockImplementation(async (cookies: readonly { cookie: Cookie; url: string }[]) =>
        identitiesFromClearCookies(cookies).filter((identity) => identity.name !== 'second')
      )
    const store = replaceStore(existing, { snapshot })

    await expect(replaceCookiesForImportedDomains(store, ['example.com'])).rejects.toThrow(
      'the session was left unchanged'
    )
    expect(store.remove).not.toHaveBeenCalled()
    expect(store.restoreClearIdentities).not.toHaveBeenCalled()
  })

  it('reports both failures when the CDP rollback itself fails', async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cookie store unavailable'))
    const restore = vi.fn().mockRejectedValue(new Error('debugger detached'))
    const store = replaceStore(
      [cookie('.example.com', 'first', '/one'), cookie('.example.com', 'second', '/two')],
      { remove, restore }
    )

    await expect(replaceCookiesForImportedDomains(store, ['example.com'])).rejects.toThrow(
      'Cookie replacement and rollback failed'
    )
    expect(restore).toHaveBeenCalledOnce()
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

  // Why (STA-4065/STA-4797): google.com is in the import scope in these fixtures on purpose — the
  // non-transplantable exemption, not the scope, has to be what keeps the family out of the plan.
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

  // Why (STA-4797): a cookie with no usable domain cannot be in the scope of any import, so it is
  // skipped rather than failing the clear — the scope test runs before the removal-URL derivation
  // precisely so an unaddressable cookie in an unrelated corner of the jar cannot abort an import
  // that was never going to touch it. Either way it is never mutated.
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

  // Why (STA-4170): the clear may only mutate what the identity snapshot can undo, so the plan is
  // frozen from a single read. Re-reading the jar widened the removal set past the restore set.
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
      // arrived.test is in scope: only the frozen plan may be what spares it.
      importedDomainScope(['removed.test', 'survivor.test', 'arrived.test', 'google.com'])
    )

    expect(get).toHaveBeenCalledOnce()
    expect(remove.mock.calls).toEqual([
      ['https://removed.test/', 'gone-before-clear'],
      ['https://survivor.test/', 'survived']
    ])
  })

  // Why (STA-4170): arrival plus a later removal failure is the exact shape that deleted a login
  // the user had just completed and still reported restoration. Mutated set must equal restore set.
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

  // Why: the exemption is enforced per coordinate, so no removal may ever be the path that finally
  // deletes a live Google session.
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

  // Why (STA-4090): a failed clear must restore through captured identities, never cookies.set.
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
