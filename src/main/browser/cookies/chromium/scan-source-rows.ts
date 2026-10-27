import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  normalizeCookieImportDomain
} from '../browser-cookie-import-policy'
import { isExpiredImportRow } from '../browser-cookie-import-write'
import { chromiumTimestampToUnix } from '../sources/browser-cookie-sqlite'
import { databaseSameSite } from '../sources/browser-cookie-validation'
import {
  buildUndecryptableWarning,
  cookieEncryptionVersion,
  decryptCookieValueRaw
} from '../sources/browser-cookie-decryption'
import { diag } from '../browser-cookie-import-diagnostics'
import type { ChromiumImportContext } from './import-context'

/** Decrypt readable source rows for the live merge. */
export function scanChromiumCookieRows(
  context: ChromiumImportContext
): BrowserCookieImportResult | null {
  const { sourceRows, sourceKey, plannedSourceRows, partitionBySourceRow } = context

  for (const sourceRow of sourceRows) {
    const domain = sourceRow.host_key as string
    const name = sourceRow.name as string

    if (isGoogleSourceBoundCookie(name, domain)) {
      context.integritySkipped++
      continue
    }
    if (isNonTransplantableCookieDomain(domain)) {
      context.nonTransplantableSkipped++
      continue
    }

    const encRaw = sourceRow.encrypted_value
    // node:sqlite returns BLOBs as Uint8Array, rather than Buffer.
    const encBuf = encRaw instanceof Uint8Array ? Buffer.from(encRaw) : null
    const plainRaw = sourceRow.value
    let decryptedValue: Buffer
    if (encBuf && encBuf.length > 0) {
      const version = cookieEncryptionVersion(encBuf)
      const appBoundIneligible = version === 'v20'
      const keyringIneligible =
        version === 'v11' &&
        sourceKey?.mode === 'aes-128-cbc' &&
        sourceKey.keyringUnavailable === true
      const raw =
        sourceKey && !appBoundIneligible && !keyringIneligible
          ? decryptCookieValueRaw(encBuf, sourceKey, domain)
          : null
      if (!raw) {
        // Attribute failures while the encryption version is still available.
        context.decryptFailed++
        if (appBoundIneligible) {
          context.appBoundFailed++
        } else if (keyringIneligible) {
          context.keyringUnavailableFailed++
        }
        context.skipped++
        continue
      }
      decryptedValue = raw
    } else if (plainRaw instanceof Uint8Array) {
      decryptedValue = Buffer.from(plainRaw)
    } else if (typeof plainRaw === 'string') {
      decryptedValue = Buffer.from(plainRaw, 'latin1')
    } else {
      decryptedValue = Buffer.alloc(0)
    }

    let validDomain = context.sourceDomainValidity.get(domain)
    if (validDomain === undefined) {
      validDomain = normalizeCookieImportDomain(domain) !== null
      context.sourceDomainValidity.set(domain, validDomain)
    }
    if (!validDomain) {
      context.skipped++
      continue
    }
    // Unreadable partition identities cannot be imported faithfully.
    if (!plannedSourceRows.has(sourceRow)) {
      context.skipped++
      continue
    }

    const path = sourceRow.path as string
    const secure = sourceRow.is_secure === 1n
    const httpOnly = sourceRow.is_httponly === 1n
    // Missing SameSite values use Chromium’s unspecified fallback.
    const sameSite = databaseSameSite(Number(sourceRow.samesite ?? -1))
    const expiresUtc = chromiumTimestampToUnix(sourceRow.expires_utc as bigint)
    if (isExpiredImportRow({ expirationDate: expiresUtc > 0 ? expiresUtc : undefined })) {
      context.skipped++
      continue
    }
    const partition = partitionBySourceRow.get(sourceRow)!
    // latin1 preserves raw cookie bytes without UTF-8 replacement.
    const value = decryptedValue.toString('latin1')
    context.decryptedCookies.push({
      value,
      domain,
      name,
      path,
      secure,
      httpOnly,
      sameSite,
      expirationDate: expiresUtc > 0 ? expiresUtc : undefined,
      partition
    })
  }

  diag(
    `  skipped ${context.integritySkipped} Google integrity cookies (SIDCC/STRP/AEC) and ${context.nonTransplantableSkipped} non-transplantable-domain cookies`
  )
  context.googleCookiesSkipped = context.integritySkipped + context.nonTransplantableSkipped
  context.undecryptableWarning = buildUndecryptableWarning({
    decryptFailed: context.decryptFailed,
    appBoundFailed: context.appBoundFailed,
    keyringUnavailableFailed: context.keyringUnavailableFailed,
    keyringFailure:
      sourceKey?.mode === 'aes-128-cbc' && sourceKey.keyringFailure
        ? { cause: sourceKey.keyringFailure, browser: context.browser.label }
        : undefined
  })

  // Refuse before live mutation if an older client cannot report partition skips.
  if (context.partitionSkipped > 0 && context.options.canReportPartitionSkippedCookies === false) {
    return {
      ok: false,
      reason:
        'This Orca client cannot report cookies skipped for an unreadable site partition. Update Orca on this device and try again.'
    }
  }
  return null
}
