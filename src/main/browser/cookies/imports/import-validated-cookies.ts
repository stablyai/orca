import { summarizePartitionSkips } from '../browser-cookie-partition-summary'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../../../shared/browser-workspace-types'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain
} from '../policy/cookie-import-exclusions'
import { normalizeCookieImportDomain } from '../policy/cookie-domain'
import { acquireCookieMutationLock } from '../mutation/cookie-mutation-lock'
import {
  emptyImportWritePhase,
  planImportWrites,
  writeImportedCookies,
  type ImportWritePhase
} from '../browser-cookie-import-write'
import { diag } from '../browser-cookie-import-diagnostics'
import type { ValidatedCookie } from '../sources/browser-cookie-validation'
import type { CookieImportTarget, CookieImportOptions } from './cookie-import-contracts'

export async function importValidatedCookies(
  cookies: ValidatedCookie[],
  totalInput: number,
  target: CookieImportTarget,
  options: CookieImportOptions = {}
): Promise<BrowserCookieImportResult> {
  const targetPartition = target.partition
  const importDomainCache = new Map<string, boolean>()
  const validDomainCookies = cookies.filter((cookie) => {
    let valid = importDomainCache.get(cookie.domain)
    if (valid === undefined) {
      valid = normalizeCookieImportDomain(cookie.domain) !== null
      importDomainCache.set(cookie.domain, valid)
    }
    return valid
  })
  const sourceBoundFiltered = validDomainCookies.filter(
    (cookie) => !isGoogleSourceBoundCookie(cookie.name, cookie.domain)
  )
  // Preserve device-bound sessions.
  const importableCookies = sourceBoundFiltered.filter(
    (cookie) => !isNonTransplantableCookieDomain(cookie.domain)
  )
  const integritySkipped = validDomainCookies.length - sourceBoundFiltered.length
  const nonTransplantableSkipped = sourceBoundFiltered.length - importableCookies.length
  const googleCookiesSkipped = integritySkipped + nonTransplantableSkipped
  const invalidDomainSkipped = cookies.length - validDomainCookies.length
  diag(
    `importValidatedCookies: ${cookies.length} validated, ${invalidDomainSkipped} unsafe-domain skipped, ${integritySkipped} source-bound skipped, ${nonTransplantableSkipped} non-transplantable skipped of ${totalInput} total, partition="${targetPartition}"`
  )
  // Refuse unsupported reporting before opening the jar.
  const plan = planImportWrites(importableCookies)

  // Refuse before mutation when an older client cannot report partition skips.
  if (options.canReportPartitionSkippedCookies === false && plan.skips.length > 0) {
    return {
      ok: false,
      reason:
        'This Orca client cannot report cookies skipped for an unreadable site partition. Update Orca on this device and try again.'
    }
  }
  // Partition skips are already part of skippedCookies; count them only once.
  const partitionSkipped = plan.skips.length
  let skipped = totalInput - importableCookies.length + partitionSkipped
  let phase: ImportWritePhase = emptyImportWritePhase()
  const cookieClearStore = plan.writes.length > 0 ? target.openWriteStore() : null

  if (cookieClearStore) {
    const releaseMutationLock = await acquireCookieMutationLock(target.mutationLockOwner)
    try {
      const stripNonPrintable = (s: string): string => s.replace(/[^\x20-\x7E]/g, '')
      phase = await writeImportedCookies(
        cookieClearStore,
        plan.writes.map((cookie) => ({ ...cookie, value: stripNonPrintable(cookie.value) })),
        { log: diag }
      )
      skipped += phase.writeRejected + phase.expired
    } finally {
      try {
        cookieClearStore.dispose()
      } finally {
        releaseMutationLock()
      }
    }
  }

  if (phase.importedCount > 0) {
    try {
      await target.flushStore?.()
    } catch (error) {
      diag(`  cookie flush failed: ${String(error)}`)
    }
  }

  diag(
    `importValidatedCookies result: imported=${phase.importedCount} skipped=${skipped} partition-unreadable=${partitionSkipped} domains=${phase.domains.size}`
  )

  const summary: BrowserCookieImportSummary = {
    totalCookies: totalInput,
    importedCookies: phase.importedCount,
    skippedCookies: skipped,
    ...(googleCookiesSkipped > 0 ? { googleCookiesSkipped } : {}),
    ...summarizePartitionSkips(plan.skips),
    domains: [...phase.domains].sort()
  }

  return { ok: true, profileId: '', summary }
}
