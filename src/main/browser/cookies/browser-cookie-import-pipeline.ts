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

export type CookieImportPayloadParseResult =
  | { ok: true; entries: unknown[]; total: number }
  | { ok: false; reason: string }

// Why: EditThisCookie exports a bare array; Playwright storage_state wraps cookies under { cookies }.
export function parseCookieImportPayload(parsed: unknown): CookieImportPayloadParseResult {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { ok: false, reason: 'Cookie file is empty.' }
    }
    return { ok: true, entries: parsed, total: parsed.length }
  }
  if (parsed && typeof parsed === 'object') {
    const cookies = (parsed as { cookies?: unknown }).cookies
    if (Array.isArray(cookies)) {
      if (cookies.length === 0) {
        return { ok: false, reason: 'Cookie file is empty.' }
      }
      return { ok: true, entries: cookies, total: cookies.length }
    }
  }
  return {
    ok: false,
    reason:
      'Expected a JSON array of cookies (EditThisCookie) or a Playwright storage_state object with a "cookies" array.'
  }
}

// Why: Playwright uses expires (unix seconds, -1 session); EditThisCookie uses expirationDate.
function coerceCookieEntry(entry: unknown): RawCookieEntry | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const raw = entry as Record<string, unknown>
  let expirationDate: unknown = raw.expirationDate
  if (typeof expirationDate !== 'number' || !(expirationDate > 0)) {
    expirationDate =
      typeof raw.expires === 'number' && Number.isFinite(raw.expires) && raw.expires > 0
        ? raw.expires
        : undefined
  }
  return {
    domain: raw.domain,
    name: raw.name,
    value: raw.value,
    path: raw.path,
    secure: raw.secure,
    httpOnly: raw.httpOnly,
    sameSite: raw.sameSite,
    expirationDate
  }
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

  const payload = parseCookieImportPayload(parsed)
  if (!payload.ok) {
    // Empty files keep main's coded refusal. A wrong shape must name both
    // EditThisCookie arrays and Playwright storage_state; fileNotArray does not.
    if (payload.reason === 'Cookie file is empty.') {
      return browserCookieImportFailure('fileEmpty')
    }
    return { ok: false, reason: payload.reason }
  }

  const validated: ValidatedCookie[] = []
  let skipped = 0
  for (const entry of payload.entries) {
    const coerced = coerceCookieEntry(entry)
    if (!coerced) {
      skipped++
      continue
    }
    const cookie = validateCookieEntry(coerced)
    if (cookie) {
      validated.push(cookie)
    } else {
      skipped++
    }
  }

  if (validated.length === 0) {
    return browserCookieImportFailure('fileNoValidCookies', { count: skipped })
  }

  return importValidatedCookies(validated, payload.total, cookieImportTarget(targetPartition))
}
