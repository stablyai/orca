import type { Cookie } from 'electron'
import type {
  CookieClearIdentity,
  CookieClearPartitionKey,
  CookieImportWriteStore
} from './browser-cookie-import-clear'
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
  importedKeys: { url: string; name: string }[]
  importedCount: number
  writeRejected: number
  partitionSkipped: number
  domains: Set<string>
  failure: unknown
}

export function emptyImportWritePhase(): ImportWritePhase {
  return {
    importedKeys: [],
    importedCount: 0,
    writeRejected: 0,
    partitionSkipped: 0,
    domains: new Set<string>(),
    failure: null
  }
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
    try {
      await store.writeCookieIdentity(plan.identity)
      phase.importedKeys.push(importedCookieRemovalKey(plan.identity))
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
