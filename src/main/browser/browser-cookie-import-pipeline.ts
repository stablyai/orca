import { dialog, session, type BrowserWindow } from 'electron'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../shared/browser-workspace-types'
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
} from './browser-cookie-validation'

// Why (STA-4300): the import writes get a store with no `set` on it and no Session behind it, so
// the partition-dropping write is not merely unused here — it cannot be reached.
export type CookieImportSessionStore = CookieClearStore &
  CookieImportWriteStore & { dispose: () => void }

export type CookieImportTarget = {
  partition: string
  // Why (STA-4601): the live-jar lock is keyed on an object, and this path no longer holds the
  // Session that STA-4300 moved behind openWriteStore. session.fromPartition returns the SAME
  // instance for one partition string, so carrying that instance here is what keeps this path's
  // lock and the native path's lock on ONE key — a fresh object per call would serialise nothing.
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
  // Why: dropping these before the replace scope is computed is what keeps the existing
  // Google session intact — replaceCookiesForImportedDomains only clears domains we import.
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
  // Why (STA-4300 I1): every cookie's fate is decided here, before the jar is opened. The plan is
  // the single value the write set AND the removal scope both derive from, so they cannot drift
  // apart the way they did in bf6dc6fcba.
  const plan = planImportWrites(importableCookies)

  // Why (§4.3c): a family we cannot name is one we cannot exclude from the removal scope, and
  // clearing a family we cannot protect is the P0. Refuse before touching anything.
  if (plan.hasUnrepresentableSkip) {
    return {
      ok: false,
      reason:
        'Could not import: a cookie with an unreadable site partition has no registrable domain, so its existing session cannot be protected.'
    }
  }

  // Why: an older remote client cannot surface this skip, so fail before opening the target jar.
  if (options.canReportPartitionSkippedCookies === false && plan.skips.length > 0) {
    return {
      ok: false,
      reason:
        'This Orca client cannot report cookies skipped for an unreadable site partition. Update Orca on this device and try again.'
    }
  }
  // Why: a family-suppressed sibling is a partition skip too, so partitionSkippedCookies is a
  // BREAKDOWN of skippedCookies and is added into it exactly once — never a separate addend, or
  // totalCookies === importedCookies + skippedCookies silently stops holding.
  const partitionSkipped = plan.skips.length
  let skipped = totalInput - importableCookies.length + partitionSkipped
  let phase: ImportWritePhase = emptyImportWritePhase()
  // Why (STA-4097/STA-4300): both the rollback and the import writes need CDP identities — only
  // they carry partitionKey. cookies.set drops it silently, on the success path as well.
  const cookieClearStore = plan.writes.length > 0 ? target.openWriteStore() : null

  if (cookieClearStore) {
    // Why (STA-4601): the replace, the writes, and the rollback are one live-jar transaction.
    // Releasing after the replace lets a second import interleave, so this run's rollback could
    // remove cookies the newer import already wrote and reported as imported. Taken AFTER the
    // store is opened on purpose — openWriteStore only builds the adapter, it attaches no
    // debugger, so holding it while queued cannot deadlock against the holder.
    const releaseMutationLock = await acquireCookieMutationLock(target.mutationLockOwner)
    let replaced: ReplacedImportedDomainCookies | null = null
    try {
      if (mode === 'replace-imported-domains') {
        try {
          // Why (STA-4300 I2 / §2b): the removal scope is the write set. Filtering per exact
          // cookie is NOT enough — replaceCookiesForImportedDomains expands each imported domain
          // into its descendant roots, so a readable apex cookie would drag a skipped subdomain's
          // live session into the removal scope with nothing written back. plan.writes is already
          // family-closed, and using the same array for both makes them impossible to diverge.
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

      // Why: Chromium rejects any non-printable-ASCII byte in a cookie value; strip as a safety net.
      const stripNonPrintable = (s: string): string => s.replace(/[^\x20-\x7E]/g, '')
      phase = await writeImportedCookies(
        cookieClearStore,
        plan.writes.map((cookie) => ({ ...cookie, value: stripNonPrintable(cookie.value) })),
        { stopOnFailure: replaced !== null, log: diag }
      )
      // Why: plan.skips holds every partition-driven skip — the unreadable rows AND the readable
      // siblings suppressed by family closure. phase.partitionSkipped is 0 now that only planned
      // writes reach the writer, so the count comes from the plan and is added exactly once.
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
        // Why: restoreClearIdentities attaches the debugger before it iterates, so an empty
        // restore set would spin up a hidden BrowserWindow to put nothing back.
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
    ...(partitionSkipped > 0 ? { partitionSkippedCookies: partitionSkipped } : {}),
    domains: [...phase.domains].sort()
  }

  return { ok: true, profileId: '', summary }
}

// ---------------------------------------------------------------------------
// Import from JSON file
// ---------------------------------------------------------------------------

// Why: use a main-owned native dialog so a compromised renderer can't turn import into arbitrary file reads.
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
