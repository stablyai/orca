import type { Cookie, Cookies } from 'electron'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { ImportedDomainScope } from './browser-cookie-import-policy'
import {
  cookieRemovalUrl,
  domainIsInImportedScope,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain,
  registrableFamily
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

// Write through CDP identities because Electron cookies.set loses partition keys.
export type CookieImportWriteStore = Pick<Cookies, 'get' | 'remove'> & {
  writeCookieIdentity(identity: CookieClearIdentity): Promise<void>
}

// Exclude cookies.set and bulk clearData: neither preserves this per-cookie rollback contract.
export type CookieClearSession = {
  cookies: Pick<Cookies, 'get' | 'remove'>
  snapshotClearIdentities: CookieClearStore['snapshotClearIdentities']
  restoreClearIdentities: CookieClearStore['restoreClearIdentities']
}

/** Use the partition’s Electron Session as the shared lock key. */
export type CookieMutationLockOwner = WeakKey

const mutationLocks = new WeakMap<CookieMutationLockOwner, Promise<void>>()

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

/** Hold across clear, writes, and rollback so a stale rollback cannot undo a later import. */
export async function acquireCookieMutationLock(
  owner: CookieMutationLockOwner
): Promise<() => void> {
  const previous = mutationLocks.get(owner) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mutationLocks.set(
    owner,
    previous.then(() => current)
  )
  await previous
  return release
}

export async function withCookieMutationLock<T>(
  owner: CookieMutationLockOwner,
  run: () => Promise<T>
): Promise<T> {
  const release = await acquireCookieMutationLock(owner)
  try {
    return await run()
  } finally {
    release()
  }
}

function removableCookieEntries(
  cookies: readonly Cookie[],
  preserveFamilies: ReadonlySet<string>,
  importScope: ImportedDomainScope
): { cookie: Cookie; url: string }[] {
  const removable: { cookie: Cookie; url: string }[] = []
  for (const cookie of cookies) {
    if (isNonTransplantableCookieDomain(cookie.domain ?? '')) {
      continue
    }
    // Scope first so unrelated, unaddressable cookies cannot abort the import.
    const scopedDomain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    if (
      scopedDomain === null ||
      !domainIsInImportedScope(importScope, scopedDomain, cookie.hostOnly === true)
    ) {
      continue
    }
    // Keep unreadable families out of both removal and rollback snapshots.
    if (preserveFamilies.size > 0) {
      const family = registrableFamily(cookie.domain ?? '')
      if (family !== null && preserveFamilies.has(family)) {
        continue
      }
    }
    removable.push({ cookie, url: cookieRemovalUrl(cookie, scopedDomain) })
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

/** This adapter lock does not replace the importer’s Session lock across clear/write/rollback. */
export async function removeTransplantableCookies(
  targetSession: CookieClearSession,
  preserveFamilies: ReadonlySet<string>,
  importScope: ImportedDomainScope
): Promise<void> {
  return withCookieMutationLock(targetSession, async () => {
    const store = targetSession.cookies
    if (importScope.exact.size === 0) {
      return
    }
    const initialCookies = await store.get({})
    if (initialCookies.length === 0) {
      return
    }

    const initialRemovable = removableCookieEntries(initialCookies, preserveFamilies, importScope)
    if (initialRemovable.length === 0) {
      return
    }
    const identities = await targetSession.snapshotClearIdentities(initialRemovable)
    assertClearIdentitiesCoverRemovable(initialRemovable, identities)
    // Freeze the removal plan so newly arrived cookies cannot exceed the rollback snapshot.
    const removalGroups = [...groupRemovableCookies(initialRemovable).values()]

    // Bulk clearData matches registrable domains and could delete unsnapshotted host-only siblings.
    const results = await mapSettledWithConcurrency(
      removalGroups,
      COOKIE_CLEAR_CONCURRENCY,
      async (group) => {
        // Serialize removals that share a coordinate.
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
