import type { Cookie } from 'electron'
import type {
  CookieClearIdentity,
  CookieClearPartitionKey,
  CookieImportWriteStore
} from './browser-cookie-import-clear'
import { registrableFamily } from './browser-cookie-import-policy'
import type { SourcePartitionRead } from './cookies/sources/browser-cookie-source-partition'

export type ImportedCookieFields = {
  url: string
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: Cookie['sameSite']
  expirationDate: number | undefined
}

export type ImportWritePlan =
  | { status: 'write'; identity: CookieClearIdentity }
  | { status: 'skip'; reason: string }

const HOST_PREFIX = '__Host-'

export function importedCookieIdentity(
  cookie: ImportedCookieFields,
  partitionKey: CookieClearPartitionKey | undefined
): CookieClearIdentity {
  // __Host- cookies require path=/ and no domain attribute; hostOnly omits domain in CDP.
  const isHostPrefixed = cookie.name.startsWith(HOST_PREFIX)
  return {
    url: cookie.url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: isHostPrefixed,
    path: isHostPrefixed ? '/' : cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    ...(partitionKey ? { partitionKey } : {})
  }
}

export function planImportedCookieWrite(
  cookie: ImportedCookieFields,
  partition: SourcePartitionRead
): ImportWritePlan {
  if (partition.status === 'unreadable') {
    return { status: 'skip', reason: partition.reason }
  }
  return {
    status: 'write',
    identity: importedCookieIdentity(
      cookie,
      partition.status === 'partitioned' ? partition.partitionKey : undefined
    )
  }
}

// Rollback removal is path-sensitive; use the resolved identity path.
export function importedCookieRemovalKey(identity: CookieClearIdentity): {
  url: string
  name: string
} {
  const removalUrl = new URL(identity.url)
  const path = identity.path ?? '/'
  removalUrl.pathname = path.startsWith('/') ? path : '/'
  return { url: removalUrl.toString(), name: identity.name }
}

export type SourceCookieToWrite = ImportedCookieFields & { partition: SourcePartitionRead }

export type ImportWritePhase = {
  attemptedKeys: { url: string; name: string }[]
  importedCount: number
  writeRejected: number
  partitionSkipped: number
  domains: Set<string>
  failure: unknown
}

export function emptyImportWritePhase(): ImportWritePhase {
  return {
    attemptedKeys: [],
    importedCount: 0,
    writeRejected: 0,
    partitionSkipped: 0,
    domains: new Set<string>(),
    failure: null
  }
}

export type PlannableCookie = { domain: string; partition: SourcePartitionRead }

export type ImportWriteSkip<T extends PlannableCookie = SourceCookieToWrite> = {
  cookie: T
  reason: string
}

export type ImportWritePlanResult<T extends PlannableCookie = SourceCookieToWrite> = {
  writes: T[]
  skips: ImportWriteSkip<T>[]
  skippedFamilies: Set<string>
  /** Refuse before mutation if a skipped family cannot be protected from removal. */
  hasUnrepresentableSkip: boolean
}

/** Classify all skips before emitting writes so later unreadable rows also suppress earlier siblings. */
export function planImportWrites<T extends PlannableCookie>(
  cookies: readonly T[]
): ImportWritePlanResult<T> {
  const provisional: T[] = []
  const skips: ImportWriteSkip<T>[] = []
  const skippedFamilies = new Set<string>()
  let hasUnrepresentableSkip = false

  for (const cookie of cookies) {
    if (cookie.partition.status === 'unreadable') {
      const family = registrableFamily(cookie.domain)
      if (family === null) {
        hasUnrepresentableSkip = true
      } else {
        skippedFamilies.add(family)
      }
      skips.push({ cookie, reason: cookie.partition.reason })
      continue
    }
    provisional.push(cookie)
  }

  // Suppress readable siblings too, or their removal scope would erase skipped sessions.
  const writes: T[] = []
  for (const cookie of provisional) {
    const family = registrableFamily(cookie.domain)
    if (family !== null && skippedFamilies.has(family)) {
      skips.push({ cookie, reason: 'family partition unreadable' })
      continue
    }
    writes.push(cookie)
  }

  return { writes, skips, skippedFamilies, hasUnrepresentableSkip }
}

function summaryDomain(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain
}

function firstNonPrintable(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) {
      return `pos=${index} char=U+${code.toString(16).padStart(4, '0')}`
    }
  }
  return 'none found'
}

/** Stop on the first failure after replacement so the caller can roll back the entire import. */
export async function writeImportedCookies(
  store: Pick<CookieImportWriteStore, 'writeCookieIdentity'>,
  cookies: readonly SourceCookieToWrite[],
  options: { stopOnFailure: boolean; log: (message: string) => void }
): Promise<ImportWritePhase> {
  const phase = emptyImportWritePhase()

  for (const cookie of cookies) {
    const plan = planImportedCookieWrite(cookie, cookie.partition)
    if (plan.status === 'skip') {
      phase.partitionSkipped += 1
      options.log(
        `  cookie skipped, unreadable partition: domain=${summaryDomain(cookie.domain)} ${plan.reason}`
      )
      continue
    }
    // Record before dispatch: a rejected CDP command may already have written the cookie.
    phase.attemptedKeys.push(importedCookieRemovalKey(plan.identity))
    try {
      await store.writeCookieIdentity(plan.identity)
      phase.importedCount += 1
      phase.domains.add(summaryDomain(cookie.domain))
    } catch (err) {
      phase.writeRejected += 1
      phase.failure = err
      if (phase.writeRejected <= 5) {
        options.log(
          `  cookie write REJECTED: domain=${summaryDomain(cookie.domain)} valLen=${cookie.value.length} badChar=${firstNonPrintable(cookie.value)} err=${String(err)}`
        )
      }
      if (options.stopOnFailure) {
        break
      }
    }
  }

  return phase
}
