import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Cookie } from 'electron'
import {
  identitiesFromClearCookies,
  removeTransplantableCookies
} from './browser-cookie-import-clear'
import { importedDomainScope } from './browser-cookie-import-policy'

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
})
