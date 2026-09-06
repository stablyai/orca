import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  normalizeCookieImportDomain,
  importedDomainScope
} from './browser-cookie-import-policy'
import { prepareStagedCookiesForImport } from './browser-cookie-staged-import'
import { chromiumTimestampToUnix, buildChromiumCookieInsertParams } from './browser-cookie-sqlite'
import { chromiumSameSite } from './browser-cookie-validation'
import {
  buildUndecryptableWarning,
  cookieEncryptionVersion,
  decryptCookieValueRaw
} from './browser-cookie-decryption'
import { diag } from './browser-cookie-import-diagnostics'
import type { ChromiumImportContext } from './browser-cookie-chromium-types'

/**
 * Decrypts and validates source rows without touching the target cookie jar.
 * Keeping this pass separate makes the write scope derive from one complete plan.
 */
export function scanChromiumCookieRows(
  context: ChromiumImportContext
): BrowserCookieImportResult | null {
  const { sourceRows, sourceKey, plannedSourceRows, partitionBySourceRow, targetColumnInfo } =
    context

  for (const sourceRow of sourceRows) {
    const domain = sourceRow.host_key as string
    const name = sourceRow.name as string

    if (isGoogleSourceBoundCookie(name, domain)) {
      context.integritySkipped++
      continue
    }
    // Why: transplanting these replaces a working sign-in with a session the site rejects.
    if (isNonTransplantableCookieDomain(domain)) {
      context.nonTransplantableSkipped++
      continue
    }

    const encRaw = sourceRow.encrypted_value
    // Why: node:sqlite returns BLOBs as Uint8Array; treat any other type as missing, not an empty buffer that would silently blank the cookie value.
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
          ? decryptCookieValueRaw(encBuf, sourceKey)
          : null
      if (!raw) {
        // Why: once decrypt returns null every failure looks identical, so attribute the cause
        // here while the version prefix is still in hand. Without this an undecryptable profile
        // is indistinguishable from an empty one and reports success.
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
    // Decryption failures are already counted above. Every other row suppressed by the
    // pre-decryption family plan is counted once here, keeping partitionSkipped a breakdown.
    if (!plannedSourceRows.has(sourceRow)) {
      context.skipped++
      continue
    }

    const path = sourceRow.path as string
    const secure = sourceRow.is_secure === 1n
    const httpOnly = sourceRow.is_httponly === 1n
    const sameSite = chromiumSameSite(Number(sourceRow.samesite ?? 0))
    const expiresUtc = chromiumTimestampToUnix(sourceRow.expires_utc as bigint)
    const partition = partitionBySourceRow.get(sourceRow)!
    // Why: cookie values are raw bytes, not UTF-8; latin1 preserves 0x00–0xFF without lossy replacement.
    const value = decryptedValue.toString('latin1')
    // Why (STA-4300 I1): SCAN only. Nothing is emitted here — not decryptedCookies, not
    // domainSet, not a staging row, not the imported count. bf6dc6fcba pushed the cookie and
    // THEN applied the unreadable guard, so an unreadable row discovered late could not retract
    // a sibling already emitted, and the jar-wide clear then removed more than was written back.
    context.scanned.push({
      entry: {
        decryptedValue,
        value,
        domain,
        name,
        path,
        secure,
        httpOnly,
        sameSite,
        expirationDate: expiresUtc > 0 ? expiresUtc : undefined,
        partition
      },
      sourceRow
    })
  }

  for (const { entry } of context.scanned) {
    context.domainSet.add(entry.domain.startsWith('.') ? entry.domain.slice(1) : entry.domain)
  }
  // Why (STA-4797): the import may only destroy what it is replacing. Naming the scope from the
  // plan — the same rows the writes come from — is what keeps the removal set from drifting past
  // the write set, and it is derived here rather than at the clear because the staged image below
  // has to be cleared to the identical scope.
  context.importScope = importedDomainScope([...context.domainSet])

  // Why (STA-4797): the staged image must carry the same imported-domain scope as the live clear.
  // Cold-start replay uses it to replace only those rows and preserve newer unrelated sessions.
  if (context.stagingDb && context.insertStmt) {
    try {
      prepareStagedCookiesForImport(context.stagingDb, context.importScope)
    } catch (err) {
      context.disableStaging(String(err))
    }
  }

  // EMIT: everything downstream derives from the plan, so there is no second place a row can
  // leak in.
  for (const { entry, sourceRow } of context.scanned) {
    context.decryptedCookies.push(entry)
    if (context.insertStmt && targetColumnInfo) {
      try {
        const params = buildChromiumCookieInsertParams(
          targetColumnInfo,
          sourceRow,
          entry.decryptedValue
        )
        context.insertStmt.run(...params)
      } catch (err) {
        context.disableStaging(String(err))
      }
    }
    // Why: counts importable cookies, not staged rows — the summary must stay truthful when
    // the optional staging DB is unavailable.
    context.imported++
  }

  diag(
    `  skipped ${context.integritySkipped} Google integrity cookies (SIDCC/STRP/AEC) and ${context.nonTransplantableSkipped} non-transplantable-domain cookies`
  )
  context.googleCookiesSkipped = context.integritySkipped + context.nonTransplantableSkipped
  context.undecryptableWarning = buildUndecryptableWarning({
    decryptFailed: context.decryptFailed,
    appBoundFailed: context.appBoundFailed,
    keyringUnavailableFailed: context.keyringUnavailableFailed
  })

  // Why: an older remote client ignores the new counter and would present this loss as success.
  // Placed before the early return and before any jar mutation, so a client that cannot render
  // the skip fails the import outright rather than reporting a partial import as complete.
  if (context.partitionSkipped > 0 && context.options.canReportPartitionSkippedCookies === false) {
    context.closeStagingDb()
    context.discardStagingFile()
    return {
      ok: false,
      reason:
        'This Orca client cannot report cookies skipped for an unreadable site partition. Update Orca on this device and try again.'
    }
  }
  return null
}
