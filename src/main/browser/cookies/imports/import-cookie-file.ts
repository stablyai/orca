import { browserCookieImportFailure } from '../../../../shared/browser-cookie-import-failure-copy'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import { readFile } from 'node:fs/promises'
import {
  validateCookieEntry,
  type RawCookieEntry,
  type ValidatedCookie
} from '../sources/browser-cookie-validation'
import { cookieImportTarget } from '../storage/browser-cookie-session-target'
import { importValidatedCookies } from './import-validated-cookies'

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
