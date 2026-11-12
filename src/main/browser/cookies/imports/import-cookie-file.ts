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
