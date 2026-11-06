import { translateMain } from '../../i18n/main-i18n'
import { dialog, session, type BrowserWindow } from 'electron'
import { summarizePartitionSkips } from './browser-cookie-partition-summary'
import { browserCookieImportFailure } from '../../../shared/browser-cookie-import-failure-copy'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../../shared/browser-workspace-types'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  normalizeCookieImportDomain
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
import { diag } from './browser-cookie-import-diagnostics'
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
  flushStore?: () => Promise<void>
}

export type CookieImportOptions = {
  canReportPartitionSkippedCookies?: boolean
}

export function cookieImportTarget(targetPartition: string): CookieImportTarget {
  const targetSession = session.fromPartition(targetPartition)
  return {
    partition: targetPartition,
    mutationLockOwner: targetSession,
    openWriteStore: () => openCookieClearStore(targetSession),
    flushStore: () => targetSession.cookies.flushStore()
  }
}

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

// Main owns the file picker so a compromised renderer cannot request arbitrary file reads.
export async function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: translateMain('native.dialog.importCookies', 'Import Cookies'),
    filters: [
      { name: translateMain('native.dialog.cookieFiles', 'Cookie Files'), extensions: ['json'] },
      { name: translateMain('native.dialog.allFiles', 'All Files'), extensions: ['*'] }
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
    return browserCookieImportFailure('fileUnreadable')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return browserCookieImportFailure('fileInvalidJson')
  }

  if (!Array.isArray(parsed)) {
    return browserCookieImportFailure('fileNotArray')
  }

  if (parsed.length === 0) {
    return browserCookieImportFailure('fileEmpty')
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
    return browserCookieImportFailure('fileNoValidCookies', { count: skipped })
  }

  return importValidatedCookies(validated, parsed.length, cookieImportTarget(targetPartition))
}
