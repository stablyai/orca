import type { Cookie } from 'electron'
import type {
  CookieClearIdentity,
  CookieClearPartitionKey,
  CookieImportWriteStore
} from './browser-cookie-import-clear'
import { registrableFamily } from './browser-cookie-import-policy'
import type { SourcePartitionRead } from './browser-cookie-source-partition'

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
  // Why: Chromium rejects __Host- cookies unless they omit domain and use path=/; hostOnly is how
  // the identity says "omit domain", the same contract the CDP restore params already read.
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

/**
 * Decides how one source cookie is written.
 *
 * Why (STA-4300): a cookie whose partition identity is unreadable is skipped and counted, never
 * written unpartitioned. Downgrading it would import a cookie the site cannot see while reporting a
 * clean success — the silent-loss shape behind STA-4013/4061/4090/4170.
 */
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

// Why: the rollback removes by coordinate, and remove() is path-sensitive, so the key has to use
// the identity's resolved path rather than the source cookie's.
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

/** The only fields planning needs — path B plans over rows that have no resolved `url` yet. */
export type PlannableCookie = { domain: string; partition: SourcePartitionRead }

export type ImportWriteSkip<T extends PlannableCookie = SourceCookieToWrite> = {
  cookie: T
  reason: string
}

export type ImportWritePlanResult<T extends PlannableCookie = SourceCookieToWrite> = {
  writes: T[]
  skips: ImportWriteSkip<T>[]
  /** registrableFamily values whose partition could not be read faithfully. */
  skippedFamilies: Set<string>
  /**
   * True when a skipped cookie's family cannot be named (registrableFamily returned null). The
   * caller must refuse the import before mutating anything: a family we cannot name is a family we
   * cannot exclude from the removal plan, and clearing a family we cannot protect is the P0.
   */
  hasUnrepresentableSkip: boolean
}

/**
 * Decides every source cookie's fate BEFORE any jar mutation (STA-4300 invariant I1).
 *
 * Two passes, not one, and the second is not optional. Family-atomic skip is a property of the
 * whole input: with a readable `mixed.example` row *before* an unreadable `sub.mixed.example` row,
 * a per-row guard emits the readable one before anything knows the family will be skipped. Pass 1
 * classifies and collects the skipped families; pass 2 re-filters the provisional writes.
 *
 * Pure — no I/O — so the caller cannot mutate anything before the plan exists.
 */
export function planImportWrites<T extends PlannableCookie>(
  cookies: readonly T[]
): ImportWritePlanResult<T> {
  const provisional: T[] = []
  const skips: ImportWriteSkip<T>[] = []
  const skippedFamilies = new Set<string>()
  let hasUnrepresentableSkip = false

  // Pass 1: classify, and learn which families cannot be written faithfully.
  for (const cookie of cookies) {
    // Why: the skip decision is the partition read itself — the same condition
    // planImportedCookieWrite uses — so path B can plan before it has resolved a write URL.
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

  // Pass 2: a readable cookie whose family was skipped is suppressed too — otherwise its family's
  // removal scope would be widened by a domain we then decline to write back (STA-4300 §2b).
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

// Why: cookie values are secret; only the domain is ever logged or summarized.
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

/**
 * Writes one import's cookies through the CDP identity store.
 *
 * `stopOnFailure` mirrors the replace path's contract: once existing cookies have been removed, the
 * first rejection has to stop the run so the caller can roll the whole thing back.
 */
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
    // Why: a rejected CDP command can still have reached Chromium before the transport failed.
    // Record the coordinate before dispatch so a replace rollback removes every possible write.
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
