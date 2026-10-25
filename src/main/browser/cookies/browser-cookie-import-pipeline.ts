import { dialog, session, type BrowserWindow } from 'electron'
import { summarizePartitionSkips } from './browser-cookie-partition-summary'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../../shared/browser-workspace-types'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  normalizeCookieImportDomain,
  replaceCookiesForImportedDomains,
  type CookieImportMode,
  type ReplacedImportedDomainCookies
} from './browser-cookie-import-policy'
import {
  acquireCookieMutationLock,
  type CookieClearStore,
  type CookieImportWriteStore
} from './browser-cookie-import-clear'
import { openCookieClearStore } from './browser-cookie-clear-store'
import {
  emptyImportWritePhase,
  planImportWrites,
  writeImportedCookies,
  type ImportWritePhase
} from './browser-cookie-import-write'
import { readFile } from 'node:fs/promises'
import {
  diag,
  reasonWithDiagLog,
  summarizeCookieImportError
} from './browser-cookie-import-diagnostics'
import {
  validateCookieEntry,
  type RawCookieEntry,
  type ValidatedCookie
} from './sources/browser-cookie-validation'

export type CookieImportSessionStore = CookieClearStore &
  CookieImportWriteStore & { dispose: () => void }

export type CookieImportTarget = {
  partition: string
  // Reuse the Electron Session as the lock key across import paths; a fresh adapter would not serialize.
  mutationLockOwner: object
  openWriteStore: () => CookieImportSessionStore
}

export type CookieImportOptions = {
  canReportPartitionSkippedCookies?: boolean
}

export function cookieImportTarget(targetPartition: string): CookieImportTarget {
  const targetSession = session.fromPartition(targetPartition)
  return {
    partition: targetPartition,
    mutationLockOwner: targetSession,
    openWriteStore: () => openCookieClearStore(targetSession)
  }
}

export async function importValidatedCookies(
  cookies: ValidatedCookie[],
  totalInput: number,
  target: CookieImportTarget,
  mode: CookieImportMode,
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
  // Exclude device-bound sessions before deriving the replacement scope.
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
  // Derive writes and removal scope from one plan before opening the jar.
  const plan = planImportWrites(importableCookies)

  // An unnamed family cannot be protected from removal.
  if (plan.hasUnrepresentableSkip) {
    return {
      ok: false,
      reason:
        'Could not import: a cookie with an unreadable site partition has no registrable domain, so its existing session cannot be protected.'
    }
  }

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
    // Hold the Session lock through replacement, writes, and rollback; opening the adapter attaches no debugger.
    const releaseMutationLock = await acquireCookieMutationLock(target.mutationLockOwner)
    let replaced: ReplacedImportedDomainCookies | null = null
    try {
      if (mode === 'replace-imported-domains') {
        try {
          // Use the family-closed write plan so skipped siblings remain outside the removal scope.
          const replacementDomains = plan.writes.map((cookie) => cookie.domain)
          replaced = await replaceCookiesForImportedDomains(cookieClearStore, replacementDomains)
          diag(`  removed ${replaced.removed.length} existing cookies in imported domain scopes`)
        } catch (err) {
          diag(`  existing cookie replacement failed: ${summarizeCookieImportError(err)}`)
          return {
            ok: false,
            reason: reasonWithDiagLog('Could not replace existing cookies for the imported sites.')
          }
        }
      }

      // Chromium requires printable ASCII in cookie values.
      const stripNonPrintable = (s: string): string => s.replace(/[^\x20-\x7E]/g, '')
      phase = await writeImportedCookies(
        cookieClearStore,
        plan.writes.map((cookie) => ({ ...cookie, value: stripNonPrintable(cookie.value) })),
        { stopOnFailure: replaced !== null, log: diag }
      )
      skipped += phase.writeRejected

      if (phase.failure && replaced) {
        const rollbackFailures: unknown[] = []
        for (const cookie of phase.attemptedKeys.toReversed()) {
          try {
            await cookieClearStore.remove(cookie.url, cookie.name)
          } catch (err) {
            rollbackFailures.push(err)
          }
        }
        // Avoid opening a hidden debugger window for an empty restore set.
        if (replaced.identities.length > 0) {
          try {
            await cookieClearStore.restoreClearIdentities(replaced.identities.toReversed())
          } catch (err) {
            rollbackFailures.push(err)
          }
        }
        if (rollbackFailures.length > 0) {
          diag(`  cookie replacement rollback failed: ${rollbackFailures.length} operation(s)`)
        }
        return {
          ok: false,
          reason: reasonWithDiagLog('Could not safely replace cookies for the imported sites.')
        }
      }
    } finally {
      try {
        cookieClearStore.dispose()
      } finally {
        releaseMutationLock()
      }
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

// Main owns the file picker so a compromised renderer cannot request arbitrary file reads.
export async function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: 'Import Cookies',
    filters: [
      { name: 'Cookie Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile' as const]
  }
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

export async function importCookiesFromFile(
  filePath: string,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf-8')
  } catch {
    return { ok: false, reason: 'Could not read the selected file.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { ok: false, reason: 'File is not valid JSON.' }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'Expected a JSON array of cookie objects.' }
  }

  if (parsed.length === 0) {
    return { ok: false, reason: 'Cookie file is empty.' }
  }

  const validated: ValidatedCookie[] = []
  let skipped = 0
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      skipped++
      continue
    }
    const cookie = validateCookieEntry(entry as RawCookieEntry)
    if (cookie) {
      validated.push(cookie)
    } else {
      skipped++
    }
  }

  if (validated.length === 0) {
    return {
      ok: false,
      reason: `No valid cookies found. ${skipped} entries were skipped due to missing or invalid fields.`
    }
  }

  return importValidatedCookies(
    validated,
    parsed.length,
    cookieImportTarget(targetPartition),
    'replace-imported-domains'
  )
}
