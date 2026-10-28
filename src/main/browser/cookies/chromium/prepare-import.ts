import { DatabaseSync } from 'node:sqlite'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain
} from '../browser-cookie-import-policy'
import { createChromiumCookieSnapshot } from '../../chromium-cookie-snapshot'
import { planImportWrites } from '../browser-cookie-import-write'
import { readChromiumRowPartition } from '../sources/browser-cookie-source-partition'
import { diag } from '../browser-cookie-import-diagnostics'
import type { DetectedBrowser } from '../sources/browser-cookie-detection-types'
import type { CookieImportOptions } from '../browser-cookie-import-pipeline'
import type { ChromiumImportContext } from './import-context'
import type { Session } from 'electron'
import { getEncryptionKey } from '../sources/browser-cookie-key'

export type ChromiumImportPreparation =
  | { context: ChromiumImportContext }
  | { result: BrowserCookieImportResult }

export async function prepareChromiumCookieImport(
  browser: DetectedBrowser,
  options: CookieImportOptions,
  targetSession: Session
): Promise<ChromiumImportPreparation> {
  let sourceSnapshot: ReturnType<typeof createChromiumCookieSnapshot>
  try {
    // Cookies may live only in WAL; snapshot the database and WAL consistently.
    sourceSnapshot = createChromiumCookieSnapshot(browser.cookiesPath)
  } catch (err) {
    diag(`  Chromium snapshot failed: ${String(err)}`)
    return {
      result: {
        ok: false,
        reason: `Could not copy ${browser.label} cookies database. Try closing ${browser.label} first.`
      }
    }
  }

  let sourceDb: InstanceType<typeof DatabaseSync> | null = null
  let ownershipTransferred = false
  try {
    // Chromium’s microsecond timestamps can exceed safe JavaScript integers.
    sourceDb = new DatabaseSync(sourceSnapshot.databasePath, { readOnly: true, readBigInts: true })
    // Inspect version-dependent partition columns rather than guessing a missing identity.
    const sourceColumns = new Set(
      sourceDb
        .prepare('PRAGMA table_info(cookies)')
        .all()
        .flatMap((column) => (typeof column.name === 'string' ? [column.name] : []))
    )
    const sourceRows = sourceDb.prepare('SELECT * FROM cookies ORDER BY rowid').all() as Record<
      string,
      unknown
    >[]
    sourceDb.close()
    sourceDb = null
    diag(`  source has ${sourceRows.length} cookies`)
    if (sourceRows.length === 0) {
      return { result: { ok: false, reason: `No cookies found in ${browser.label}.` } }
    }

    // Plan partition skips before decryption so an unreadable value cannot hide a skipped family.
    const partitionCandidates = sourceRows.flatMap((sourceRow) => {
      const domain = sourceRow.host_key as string
      const name = sourceRow.name as string
      return isGoogleSourceBoundCookie(name, domain) || isNonTransplantableCookieDomain(domain)
        ? []
        : [{ sourceRow, domain, partition: readChromiumRowPartition(sourceRow, sourceColumns) }]
    })
    const nativePlan = planImportWrites(partitionCandidates)
    const plannedSourceRows = new Set(nativePlan.writes.map((candidate) => candidate.sourceRow))
    const partitionBySourceRow = new Map(
      partitionCandidates.map((candidate) => [candidate.sourceRow, candidate.partition])
    )
    const needsSourceKey = sourceRows.some((sourceRow) => {
      const encrypted = sourceRow.encrypted_value
      if (!(encrypted instanceof Uint8Array) || encrypted.length === 0) {
        return false
      }
      return (
        !isGoogleSourceBoundCookie(sourceRow.name as string, sourceRow.host_key as string) &&
        !isNonTransplantableCookieDomain(sourceRow.host_key as string)
      )
    })
    const sourceKey = needsSourceKey
      ? await getEncryptionKey(browser.keychainService!, browser.keychainAccount!, browser)
      : null
    if (needsSourceKey && !sourceKey) {
      return {
        result: {
          ok: false,
          reason: `Could not access ${browser.label} encryption key. The OS may have denied access.`
        }
      }
    }

    const context: ChromiumImportContext = {
      browser,
      options,
      targetSession,
      sourceSnapshot,
      sourceRows,
      nativePlan,
      plannedSourceRows,
      partitionBySourceRow,
      sourceKey,
      skipped: 0,
      decryptFailed: 0,
      appBoundFailed: 0,
      keyringUnavailableFailed: 0,
      integritySkipped: 0,
      nonTransplantableSkipped: 0,
      partitionSkipped: nativePlan.skips.length,
      googleCookiesSkipped: 0,
      memoryLoaded: 0,
      memoryFailed: 0,
      domainSet: new Set<string>(),
      decryptedCookies: [],
      sourceDomainValidity: new Map<string, boolean>()
    }

    ownershipTransferred = true
    return { context }
  } finally {
    if (!ownershipTransferred) {
      try {
        sourceDb?.close()
      } catch {
        /* best-effort */
      }
      try {
        sourceSnapshot.cleanup()
      } catch (err) {
        diag(`  Chromium snapshot cleanup failed: ${String(err)}`)
      }
    }
  }
}
