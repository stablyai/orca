import type { Cookie } from 'electron'
import type {
  CookieClearIdentity,
  CookieClearPartitionKey,
  CookieImportWriteStore
} from './browser-cookie-import-clear'
import type { SourcePartitionRead } from './sources/browser-cookie-source-partition'

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
  // Source host-only cookies must omit domain in CDP to avoid widening their scope.
  const isHostPrefixed = cookie.name.startsWith(HOST_PREFIX)
  return {
    url: cookie.url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: isHostPrefixed || !cookie.domain.startsWith('.'),
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

export type SourceCookieToWrite = ImportedCookieFields & { partition: SourcePartitionRead }

export type ImportWritePhase = {
  importedCount: number
  writeRejected: number
  expired: number
  partitionSkipped: number
  domains: Set<string>
  failure: unknown
}

export function emptyImportWritePhase(): ImportWritePhase {
  return {
    importedCount: 0,
    writeRejected: 0,
    expired: 0,
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
}

export function planImportWrites<T extends PlannableCookie>(
  cookies: readonly T[]
): ImportWritePlanResult<T> {
  const writes: T[] = []
  const skips: ImportWriteSkip<T>[] = []
  for (const cookie of cookies) {
    if (cookie.partition.status === 'unreadable') {
      skips.push({ cookie, reason: cookie.partition.reason })
    } else {
      writes.push(cookie)
    }
  }
  return { writes, skips }
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

export function isExpiredImportRow(cookie: Pick<ImportedCookieFields, 'expirationDate'>): boolean {
  return cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1_000
}

export async function writeImportedCookies(
  store: Pick<CookieImportWriteStore, 'writeCookieIdentity'>,
  cookies: readonly SourceCookieToWrite[],
  options: { log: (message: string) => void }
): Promise<ImportWritePhase> {
  const phase = emptyImportWritePhase()

  for (const cookie of cookies) {
    // Chromium treats an expired set as deletion of the destination coordinate.
    if (isExpiredImportRow(cookie)) {
      phase.expired += 1
      continue
    }
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
    }
  }

  return phase
}
