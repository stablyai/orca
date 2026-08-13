import type { Cookie, Cookies, Session } from 'electron'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import {
  cookieRemovalUrl,
  isNonTransplantableCookieDomain,
  NON_TRANSPLANTABLE_CLEAR_EXCLUDED_ORIGINS,
  normalizeCookieDomain
} from './browser-cookie-import-policy'

const COOKIE_CLEAR_CONCURRENCY = 8

export type CookieClearPartitionKey = {
  topLevelSite: string
  hasCrossSiteAncestor: boolean
}

export type CookieClearIdentity = {
  url: string
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite: Cookie['sameSite']
  expirationDate?: number
  partitionKey?: CookieClearPartitionKey
}

export type CookieClearStore = Pick<Cookies, 'get' | 'remove'> & {
  snapshotClearIdentities(
    cookies: readonly { cookie: Cookie; url: string }[]
  ): Promise<CookieClearIdentity[]>
  restoreClearIdentities(identities: readonly CookieClearIdentity[]): Promise<void>
}

// Why (STA-4061): 'set' stays out so the lossy partition-dropping reconstruction cannot return.
export type CookieClearSession = {
  cookies: Pick<Cookies, 'get' | 'remove'>
  clearData: Session['clearData']
  snapshotClearIdentities: CookieClearStore['snapshotClearIdentities']
  restoreClearIdentities: CookieClearStore['restoreClearIdentities']
}

const clearLocks = new WeakMap<object, Promise<void>>()

function cookieClearKey(url: string, name: string): string {
  return JSON.stringify([url, name])
}

export function identitiesFromClearCookies(
  cookies: readonly { cookie: Cookie; url: string }[]
): CookieClearIdentity[] {
  return cookies.map(({ cookie, url }) => ({
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  }))
}

export async function withCookieClearLock<T>(owner: object, run: () => Promise<T>): Promise<T> {
  const previous = clearLocks.get(owner) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  clearLocks.set(
    owner,
    previous.then(() => current)
  )
  await previous
  try {
    return await run()
  } finally {
    release()
  }
}

function removableCookieEntries(
  cookies: readonly Cookie[],
  requireAddressable = false
): { cookie: Cookie; url: string }[] {
  const removable: { cookie: Cookie; url: string }[] = []
  for (const cookie of cookies) {
    if (isNonTransplantableCookieDomain(cookie.domain ?? '')) {
      continue
    }
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    const url = domain ? cookieRemovalUrl(cookie, domain) : null
    if (!url) {
      if (requireAddressable) {
        throw new Error('Could not clear existing cookies; the session was left unchanged')
      }
      continue
    }
    removable.push({ cookie, url })
  }
  return removable
}

function assertClearIdentitiesCoverRemovable(
  removable: readonly { cookie: Cookie; url: string }[],
  identities: readonly CookieClearIdentity[]
): void {
  const covered = new Set(identities.map((identity) => cookieClearKey(identity.url, identity.name)))
  for (const item of removable) {
    if (!covered.has(cookieClearKey(item.url, item.cookie.name))) {
      throw new Error('Could not clear existing cookies; the session was left unchanged')
    }
  }
}

function groupRemovableCookies(
  removable: readonly { cookie: Cookie; url: string }[]
): Map<string, { cookie: Cookie; url: string }[]> {
  const groups = new Map<string, { cookie: Cookie; url: string }[]>()
  for (const item of removable) {
    const key = cookieClearKey(item.url, item.cookie.name)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return groups
}

async function restoreClearedCookies(
  targetSession: CookieClearSession,
  identities: readonly CookieClearIdentity[],
  failures: unknown[]
): Promise<never> {
  try {
    await targetSession.restoreClearIdentities(identities.toReversed())
  } catch (restoreError) {
    throw new AggregateError(
      [...failures, restoreError],
      'Could not clear existing cookies; the session was left partially cleared'
    )
  }
  throw new AggregateError(
    failures,
    'Could not clear existing cookies; existing cookies were restored'
  )
}

export async function removeTransplantableCookies(
  targetSession: CookieClearSession
): Promise<void> {
  return withCookieClearLock(targetSession, async () => {
    const store = targetSession.cookies
    const initialCookies = await store.get({})
    if (initialCookies.length === 0) {
      return
    }

    const initialRemovable = removableCookieEntries(initialCookies, true)
    if (initialRemovable.length === 0) {
      return
    }
    const identities = await targetSession.snapshotClearIdentities(initialRemovable)
    assertClearIdentitiesCoverRemovable(initialRemovable, identities)

    try {
      // Why (STA-4065): excludeOrigins keeps the google.com family, including partitioned
      // cookies, so one call replaces a remove() per cookie on the ordinary import path.
      await targetSession.clearData({
        dataTypes: ['cookies'],
        excludeOrigins: NON_TRANSPLANTABLE_CLEAR_EXCLUDED_ORIGINS
      })
      return
    } catch {
      // Why: a rejected bulk clear can still have emptied part of the jar.
    }

    const existingCookies = await store.get({})
    const removableGroups = groupRemovableCookies(removableCookieEntries(existingCookies))
    const results = await mapSettledWithConcurrency(
      [...removableGroups.values()],
      COOKIE_CLEAR_CONCURRENCY,
      async (group) => {
        // Why: identical removal coordinates must stay ordered instead of racing.
        for (const { cookie, url } of group) {
          await store.remove(url, cookie.name)
        }
      }
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      await restoreClearedCookies(targetSession, identities, failures)
    }
  })
}
