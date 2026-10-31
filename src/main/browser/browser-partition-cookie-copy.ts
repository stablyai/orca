/**
 * Copies one browser partition's cookies into another, without overwriting what the target holds
 * and without touching the source. Reads and writes go through CDP: Electron's cookies API drops
 * the partition key, which would turn a partitioned cookie into a cross-site one.
 */
import { session } from 'electron'
import {
  emptyWslMoveBrowserCookieCopyCounts,
  type WslMoveBrowserCookieCopyCounts
} from '../../shared/wsl-move/wsl-move-browser-cookie-copy'
import type { CdpCookie } from './browser-cdp-cookie'
import { identityFromCdpCookie, openCookieClearStore } from './cookies/browser-cookie-clear-store'
import {
  withCookieMutationLock,
  type CookieClearIdentity
} from './cookies/browser-cookie-import-clear'
import {
  isNonTransplantableCookieDomain,
  normalizeCookieDomain
} from './cookies/browser-cookie-import-policy'

export type BrowserPartitionCookieCopyCounts = WslMoveBrowserCookieCopyCounts

export type BrowserPartitionCookieCopyPlan = {
  writes: CookieClearIdentity[]
  /** Skip and reject counts; the copy adds the write results. */
  counts: BrowserPartitionCookieCopyCounts
}

/** Pure: what to write from `source` into a jar that already holds `destination`. */
export function planBrowserPartitionCookieCopy(
  source: readonly CdpCookie[],
  destination: readonly CdpCookie[]
): BrowserPartitionCookieCopyPlan {
  const counts = emptyWslMoveBrowserCookieCopyCounts()
  const present = new Set<string>()
  for (const cookie of destination) {
    const key = cookieKey(cookie)
    if (key) {
      present.add(key)
    }
  }
  const writes: CookieClearIdentity[] = []
  for (const cookie of source) {
    const key = cookieKey(cookie)
    const host = typeof cookie.domain === 'string' ? normalizeCookieDomain(cookie.domain) : null
    if (!key || !host || typeof cookie.value !== 'string') {
      counts.rejected += 1
      continue
    }
    if (isNonTransplantableCookieDomain(host)) {
      counts.skippedSourceBound += 1
      continue
    }
    if (cookie.partitionKeyOpaque === true) {
      counts.skippedOpaquePartition += 1
      continue
    }
    if (present.has(key)) {
      counts.skippedPresent += 1
      continue
    }
    let identity: CookieClearIdentity
    try {
      identity = identityFromCdpCookie(cookieUrl(cookie, host), cookie)
    } catch {
      counts.rejected += 1
      continue
    }
    present.add(key)
    writes.push(identity)
  }
  return { writes, counts }
}

/**
 * Merges `sourcePartition`'s cookies into `destinationPartition`. Re-running it after a crash
 * writes nothing twice: every cookie the first run wrote is already present.
 */
export async function copyBrowserPartitionCookies(
  sourcePartition: string,
  destinationPartition: string
): Promise<BrowserPartitionCookieCopyCounts> {
  if (sourcePartition === destinationPartition) {
    throw new Error('browser_partition_cookie_copy_same_partition')
  }
  const destinationSession = session.fromPartition(destinationPartition)
  const source = openCookieClearStore(session.fromPartition(sourcePartition))
  const destination = openCookieClearStore(destinationSession)
  try {
    const sourceCookies = await source.readAllCdpCookies()
    return await withCookieMutationLock(destinationSession, async () => {
      const plan = planBrowserPartitionCookieCopy(
        sourceCookies,
        await destination.readAllCdpCookies()
      )
      for (const identity of plan.writes) {
        try {
          await destination.writeCookieIdentity(identity)
        } catch {
          plan.counts.rejected += 1
          continue
        }
        plan.counts.copied += 1
        plan.counts.copiedHttpOnly += identity.httpOnly === true ? 1 : 0
        plan.counts.copiedPartitioned += identity.partitionKey ? 1 : 0
        plan.counts.copiedSessionOnly += identity.expirationDate === undefined ? 1 : 0
      }
      return plan.counts
    })
  } finally {
    source.dispose()
    destination.dispose()
  }
}

/** Resolves once the partition's cookie writes are on disk, not just in memory. */
export function flushBrowserPartitionCookies(partition: string): Promise<void> {
  return session.fromPartition(partition).cookies.flushStore()
}

function cookieKey(cookie: CdpCookie): string | null {
  if (typeof cookie.name !== 'string' || typeof cookie.domain !== 'string' || !cookie.domain) {
    return null
  }
  const partitionKey = cookie.partitionKey
    ? [cookie.partitionKey.topLevelSite ?? null, cookie.partitionKey.hasCrossSiteAncestor ?? null]
    : null
  return JSON.stringify([
    cookie.name,
    cookie.domain.toLowerCase(),
    cookie.path || '/',
    partitionKey,
    cookie.partitionKeyOpaque === true
  ])
}

function cookieUrl(cookie: CdpCookie, host: string): string {
  const url = new URL(`${cookie.secure ? 'https' : 'http'}://${host}/`)
  url.pathname = cookie.path?.startsWith('/') ? cookie.path : '/'
  return url.toString()
}
