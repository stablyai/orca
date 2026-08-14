import { describe, expect, it } from 'vitest'
import type { Cookie } from 'electron'
import {
  identitiesFromClearCookies,
  removeTransplantableCookies,
  type CookieClearIdentity,
  type CookieClearSession
} from './browser-cookie-import-clear'

function cookie(domain: string, name: string, path = '/', secure = true): Cookie {
  return {
    domain,
    name,
    path,
    secure,
    sameSite: 'unspecified',
    value: `${name}-value`
  }
}

function valueCookie(domain: string, name: string, value: string): Cookie {
  return { ...cookie(domain, name), value }
}

function createJarSession(
  initial: Cookie[],
  options: {
    failOn?: string
    restoreError?: Error
    snapshot?: CookieClearSession['snapshotClearIdentities']
    arrivalDuringClear?: Cookie
  } = {}
) {
  let jar = [...initial]
  const removedNames: string[] = []
  const restoredNames: string[] = []
  const session: CookieClearSession & {
    names: () => string[]
    removedNames: () => string[]
    restoredNames: () => string[]
  } = {
    cookies: {
      get: async () => [...jar],
      remove: async (_url, name) => {
        if (name === (options.failOn ?? 'stale')) {
          throw new Error('cookie store unavailable')
        }
        removedNames.push(name)
        jar = jar.filter((entry) => entry.name !== name)
      }
    },
    clearData: async () => {
      // Why: a cookie the user creates mid-clear lands before the rejection surfaces.
      if (options.arrivalDuringClear) {
        jar.push(options.arrivalDuringClear)
      }
      throw new Error('storage busy')
    },
    snapshotClearIdentities:
      options.snapshot ?? (async (items) => identitiesFromClearCookies(items)),
    restoreClearIdentities: async (identities) => {
      restoredNames.push(...identities.map((identity) => identity.name))
      if (options.restoreError) {
        throw options.restoreError
      }
      for (const identity of identities) {
        if (jar.some((entry) => entry.name === identity.name)) {
          continue
        }
        jar.push(cookie(identity.domain ?? '', identity.name, identity.path, identity.secure))
      }
    },
    names: () => jar.map((entry) => entry.name).sort(),
    removedNames: () => [...removedNames],
    restoredNames: () => [...restoredNames].sort()
  }
  return session
}

describe('STA-4090 failed full cookie clear', () => {
  it('does not permanently delete a cookie removed before another removal rejects', async () => {
    const session = createJarSession([
      cookie('.google.com', 'SID'),
      cookie('.example.com', 'removed-first', '/one'),
      cookie('.other.test', 'stale', '/two')
    ])

    await expect(removeTransplantableCookies(session)).rejects.toThrow(
      /existing cookies were restored/
    )

    expect(session.removedNames()).toEqual(['removed-first'])
    expect(session.names()).toEqual(['SID', 'removed-first', 'stale'])
  })

  it('does not start removing when a cookie identity cannot be snapshotted', async () => {
    const session = createJarSession(
      [cookie('.example.com', 'removed-first'), cookie('.other.test', 'stale')],
      {
        snapshot: async (items) =>
          identitiesFromClearCookies(items.filter(({ cookie: entry }) => entry.name !== 'stale'))
      }
    )

    await expect(removeTransplantableCookies(session)).rejects.toThrow(
      /the session was left unchanged/
    )
    expect(session.removedNames()).toEqual([])
    expect(session.names()).toEqual(['removed-first', 'stale'])
  })

  it('reports a partial clear only when restore also fails', async () => {
    const session = createJarSession(
      [cookie('.example.com', 'removed-first'), cookie('.other.test', 'stale')],
      { restoreError: new Error('restore rejected') }
    )

    await expect(removeTransplantableCookies(session)).rejects.toThrow(
      /the session was left partially cleared/
    )
    expect(session.names()).toEqual(['stale'])
  })

  it('restores a partitioned identity through the captured restore channel', async () => {
    const identities: CookieClearIdentity[] = []
    const session: CookieClearSession = {
      cookies: {
        get: async () => [cookie('.example.com', 'removed-first'), cookie('.other.test', 'stale')],
        remove: async (_url, name) => {
          if (name === 'stale') {
            throw new Error('cookie store unavailable')
          }
        }
      },
      clearData: async () => {
        throw new Error('storage busy')
      },
      snapshotClearIdentities: async (items) =>
        identitiesFromClearCookies(items).map((identity) =>
          identity.name === 'removed-first'
            ? {
                ...identity,
                partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
              }
            : identity
        ),
      restoreClearIdentities: async (restored) => {
        identities.push(...restored)
      }
    }

    await expect(removeTransplantableCookies(session)).rejects.toThrow(
      /existing cookies were restored/
    )
    expect(identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'removed-first',
          partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
        }),
        expect.objectContaining({ name: 'stale' })
      ])
    )
  })

  // Why (STA-4170): the fallback used to re-read the jar, so a login completed mid-clear was
  // deleted with no snapshot identity to restore it — permanent auth loss reported as a restore.
  it('leaves a cookie that arrived during the clear in the jar', async () => {
    const session = createJarSession(
      [cookie('.example.com', 'removed-first', '/one'), cookie('.other.test', 'stale', '/two')],
      { arrivalDuringClear: cookie('.arrived.test', 'fresh-login') }
    )

    await expect(removeTransplantableCookies(session)).rejects.toThrow(
      /existing cookies were restored/
    )

    expect(session.removedNames()).toEqual(['removed-first'])
    expect(session.names()).toEqual(['fresh-login', 'removed-first', 'stale'])
    // The restore set is exactly the mutated set: the arrival never needed restoring.
    expect(session.restoredNames()).toEqual(['removed-first', 'stale'])
  })

  // Why (STA-4170): an arrival that reuses a snapshotted url+name IS removed — that coordinate is
  // what the clear was asked to empty. It is not a loss: the identity is in the snapshot, so the
  // rollback repopulates it with the pre-clear value and the coordinate is never left empty.
  it('rolls a same-coordinate arrival back to its pre-clear value', async () => {
    let jar = [valueCookie('.example.com', 'session', 'pre-clear'), cookie('.other.test', 'stale')]
    const restored: CookieClearIdentity[] = []
    const session: CookieClearSession = {
      cookies: {
        get: async () => [...jar],
        remove: async (_url, name) => {
          if (name === 'stale') {
            throw new Error('cookie store unavailable')
          }
          jar = jar.filter((entry) => entry.name !== name)
        }
      },
      clearData: async () => {
        // The site re-sets the same cookie while the bulk clear is failing.
        jar = jar.filter((entry) => entry.name !== 'session')
        jar.push(valueCookie('.example.com', 'session', 'mid-clear'))
        throw new Error('storage busy')
      },
      snapshotClearIdentities: async (items) => identitiesFromClearCookies(items),
      restoreClearIdentities: async (identities) => {
        restored.push(...identities)
        for (const identity of identities) {
          if (jar.some((entry) => entry.name === identity.name)) {
            continue
          }
          jar.push(valueCookie(identity.domain ?? '', identity.name, identity.value))
        }
      }
    }

    await expect(removeTransplantableCookies(session)).rejects.toThrow(
      /existing cookies were restored/
    )

    expect(jar.map((entry) => [entry.name, entry.value])).toEqual([
      ['stale', 'stale-value'],
      ['session', 'pre-clear']
    ])
    expect(restored.map((identity) => identity.name)).toContain('session')
  })

  it('serializes concurrent clears on the same session', async () => {
    const activeClears: number[] = []
    let inClear = 0
    const session: CookieClearSession = {
      cookies: {
        get: async () => [cookie('.example.com', 'session')],
        remove: async () => {
          inClear += 1
          activeClears.push(inClear)
          await Promise.resolve()
          inClear -= 1
        }
      },
      clearData: async () => {
        throw new Error('storage busy')
      },
      snapshotClearIdentities: async (items) => identitiesFromClearCookies(items),
      restoreClearIdentities: async () => undefined
    }

    await Promise.all([removeTransplantableCookies(session), removeTransplantableCookies(session)])

    expect(activeClears).toEqual([1, 1])
  })
})
