import type { Cookie, Cookies, Session } from 'electron'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import {
  cookieRemovalUrl,
  isNonTransplantableCookieDomain,
  NON_TRANSPLANTABLE_CLEAR_EXCLUDED_ORIGINS,
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

// Why (STA-4300): the import writes go through this store, and 'set' stays out of it for the same
// reason it stays out of the clear path — cookies.set() drops partitionKey silently, so a CHIPS
// cookie imported through it is downgraded on the success path with nothing to report it.
export type CookieImportWriteStore = Pick<Cookies, 'get' | 'remove'> & {
  writeCookieIdentity(identity: CookieClearIdentity): Promise<void>
}

// Why (STA-4061): 'set' stays out so the lossy partition-dropping reconstruction cannot return.
export type CookieClearSession = {
  cookies: Pick<Cookies, 'get' | 'remove'>
  clearData: Session['clearData']
  snapshotClearIdentities: CookieClearStore['snapshotClearIdentities']
  restoreClearIdentities: CookieClearStore['restoreClearIdentities']
}

const mutationLocks = new WeakMap<object, Promise<void>>()

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

/**
 * Serialises every live-jar mutation for one owner.
 *
 * Why (STA-4601): an import's clear, its writes, and its rollback are one transaction. Holding the
 * lock for the clear alone lets a second import interleave between them, so a stale rollback can
 * remove cookies the newer import already reported as written. Callers that need the lock across a
 * try/finally take it directly; callers with a single callback use the wrapper below.
 */
export async function acquireCookieMutationLock(owner: object): Promise<() => void> {
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

export async function withCookieMutationLock<T>(owner: object, run: () => Promise<T>): Promise<T> {
  const release = await acquireCookieMutationLock(owner)
  try {
    return await run()
  } finally {
    release()
  }
}

function removableCookieEntries(
  cookies: readonly Cookie[],
  preserveFamilies: ReadonlySet<string>
): { cookie: Cookie; url: string }[] {
  const removable: { cookie: Cookie; url: string }[] = []
  for (const cookie of cookies) {
    if (isNonTransplantableCookieDomain(cookie.domain ?? '')) {
      continue
    }
    // Why (STA-4300 I2): a family whose partition could not be read faithfully is neither written
    // nor removed. Filtering HERE keeps it out of the removal plan and — because the CDP snapshot
    // is taken from this same list — out of the restore set too, so it is never submitted to any
    // mutation at all.
    if (preserveFamilies.size > 0) {
      const family = registrableFamily(cookie.domain ?? '')
      if (family !== null && preserveFamilies.has(family)) {
        continue
      }
    }
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    const url = domain ? cookieRemovalUrl(cookie, domain) : null
    if (!url) {
      throw new Error('Could not clear existing cookies; the session was left unchanged')
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

/**
 * Clears the transplantable cookies from a jar.
 *
 * Why (STA-4601): this takes the mutation lock on the object it is PASSED, which serialises direct
 * callers that hand it a real Session — pinned by "serializes concurrent clears on the same
 * session" in the atomicity suite. It does NOT serialise the importer, because both import paths
 * build a fresh adapter object per call, so the key is new every time and this lock is a no-op for
 * them. That is deliberate and safe: the importer holds the real per-partition lock, keyed on the
 * Electron Session, across its whole clear-and-write transaction — a scope this function cannot
 * see. Do not remove the importer's outer lock on the assumption that this one covers it.
 */
export async function removeTransplantableCookies(
  targetSession: CookieClearSession,
  preserveFamilies: ReadonlySet<string> = new Set()
): Promise<void> {
  return withCookieMutationLock(targetSession, async () => {
    const store = targetSession.cookies
    const initialCookies = await store.get({})
    if (initialCookies.length === 0) {
      return
    }

    const initialRemovable = removableCookieEntries(initialCookies, preserveFamilies)
    if (initialRemovable.length === 0) {
      return
    }
    const identities = await targetSession.snapshotClearIdentities(initialRemovable)
    assertClearIdentitiesCoverRemovable(initialRemovable, identities)
    // Why (STA-4170): fixing the removal plan here, beside the identities that can undo it, is what
    // keeps the two sets equal. Re-reading the jar in the fallback widened the removal set past the
    // restore set, so a cookie that arrived mid-clear — a login the user had just completed — was
    // deleted with nothing able to put it back. Removing an already-deleted cookie is a harmless
    // no-op, so the stale plan costs nothing; only its narrowness matters.
    const removalGroups = [...groupRemovableCookies(initialRemovable).values()]

    // Why (STA-4300 §4.3a): bulk clearData removes everything outside excludeOrigins, and its own
    // contract admits a rejection may already have emptied part of the jar. Handing it a
    // dynamically derived preserve list cannot be made safe: a partial delete followed by a
    // rejection would destroy a preserved family with no identity to restore it from, because the
    // preserved coordinates are deliberately absent from the snapshot. So when anything is
    // preserved we do not use the bulk path at all — the frozen per-coordinate plan, which already
    // excludes those families, becomes the primary path. Nothing is preserved on the ordinary
    // import, so that path keeps today's single clearData call unchanged.
    if (preserveFamilies.size === 0) {
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
    }

    const results = await mapSettledWithConcurrency(
      removalGroups,
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
