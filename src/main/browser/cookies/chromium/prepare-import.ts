import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { BrowserCookieImportResult } from '../../../../shared/browser-workspace-types'
import { supportsPendingBrowserCookieImportReplay } from '../../browser-session-cookie-staging'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain
} from '../browser-cookie-import-policy'
import { createChromiumCookieSnapshot } from '../../chromium-cookie-snapshot'
import { resolveChromiumCookiesPath } from '../../chromium-cookie-path'
import { copyFileWithWindowsRetry } from '../../../../shared/windows-retry-file-operations'
import { planImportWrites } from '../browser-cookie-import-write'
import { readChromiumRowPartition } from '../sources/browser-cookie-source-partition'
import { diag } from '../browser-cookie-import-diagnostics'
import type { DetectedBrowser } from '../sources/browser-cookie-detection-types'
import type { CookieImportOptions } from '../browser-cookie-import-pipeline'
import type { ChromiumCookieColumnInfo } from '../sources/browser-cookie-sqlite'
import type { ChromiumImportContext } from './import-context'
import type { Session } from 'electron'
import { getEncryptionKey } from '../sources/browser-cookie-key'

export type ChromiumImportPreparation =
  | { context: ChromiumImportContext }
  | { result: BrowserCookieImportResult }

export async function prepareChromiumCookieImport(
  browser: DetectedBrowser,
  targetPartition: string,
  options: CookieImportOptions,
  targetSession: Session
): Promise<ChromiumImportPreparation> {
  await targetSession.cookies.flushStore()
  // Ask Electron for its storage path; deriving it from an untrusted partition string permits traversal.
  const partitionDir = targetSession.getStoragePath()
  if (!partitionDir) {
    return {
      result: { ok: false, reason: 'Target cookie database not found. Open a browser tab first.' }
    }
  }

  const partitionName = targetPartition.replace('persist:', '')
  let liveCookiesPath = resolveChromiumCookiesPath(partitionDir)
  // The probe initializes unused profiles and must share the import lock: imports can also write __init.
  if (!liveCookiesPath) {
    try {
      await targetSession.cookies.set({ url: 'https://localhost', name: '__init', value: '1' })
      await targetSession.cookies.remove('https://localhost', '__init')
      await targetSession.cookies.flushStore()
    } catch {
      // Recheck the database path even if the initialization probe failed.
    }
    liveCookiesPath = resolveChromiumCookiesPath(partitionDir)
  }
  if (!liveCookiesPath) {
    return {
      result: { ok: false, reason: 'Target cookie database not found. Open a browser tab first.' }
    }
  }

  const stagingDir = join(app.getPath('userData'), 'cookie-import-staging')
  const partitionSegment = partitionName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const stagingCookiesPath = join(
    stagingDir,
    `Cookies-${partitionSegment}-${Date.now()}-${randomUUID()}`
  )
  // Staging failure disables restart replay without aborting live import.
  let stagingAvailable = false
  // Runtime-derived route partitions have no startup replay consumer.
  if (!supportsPendingBrowserCookieImportReplay(targetPartition)) {
    diag(`  restart fallback unsupported for partition "${targetPartition}" — not staging cookies`)
  } else {
    try {
      mkdirSync(stagingDir, { recursive: true })
      copyFileWithWindowsRetry(liveCookiesPath, stagingCookiesPath)
      stagingAvailable = true
    } catch (err) {
      const fsErr = err as NodeJS.ErrnoException
      diag(
        `  staging copy unavailable: code=${fsErr.code ?? 'unknown'} errno=${fsErr.errno ?? 'unknown'} syscall=${fsErr.syscall ?? 'unknown'} path=${liveCookiesPath} destination=${stagingCookiesPath}`
      )
      // A failed copy can leave a partial database containing real cookies.
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
    }
  }

  let sourceSnapshot: ReturnType<typeof createChromiumCookieSnapshot>
  try {
    // Cookies may live only in WAL; snapshot the database and WAL consistently.
    sourceSnapshot = createChromiumCookieSnapshot(browser.cookiesPath)
  } catch (err) {
    try {
      unlinkSync(stagingCookiesPath)
    } catch {
      /* best-effort */
    }
    diag(`  Chromium snapshot failed: ${String(err)}`)
    return {
      result: {
        ok: false,
        reason: `Could not copy ${browser.label} cookies database. Try closing ${browser.label} first.`
      }
    }
  }

  let sourceDb: InstanceType<typeof DatabaseSync> | null = null
  let stagingDb: InstanceType<typeof DatabaseSync> | null = null
  const closeStagingDb = (): void => {
    try {
      stagingDb?.close()
    } catch {
      /* best-effort */
    }
    stagingDb = null
  }
  const discardStagingFile = (): void => {
    // Remove plaintext cookie data and any SQLite sidecars.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(stagingCookiesPath + suffix)
      } catch {
        /* best-effort */
      }
    }
  }

  let ownershipTransferred = false
  try {
    // Chromium’s microsecond timestamps can exceed safe JavaScript integers.
    sourceDb = new DatabaseSync(sourceSnapshot.databasePath, { readOnly: true, readBigInts: true })
    let targetColumnInfo: ChromiumCookieColumnInfo[] | null = null
    let colList: string | null = null
    let placeholders: string | null = null
    if (stagingAvailable) {
      try {
        stagingDb = new DatabaseSync(stagingCookiesPath)
        // Keep the scope marker in the staged file itself; a lost WAL must not trigger whole-image replay.
        stagingDb.exec('PRAGMA journal_mode = DELETE')
        targetColumnInfo = stagingDb
          .prepare('PRAGMA table_info(cookies)')
          .all() as ChromiumCookieColumnInfo[]
        const targetCols = targetColumnInfo.map((row) => row.name)
        colList = targetCols.join(', ')
        placeholders = targetCols.map(() => '?').join(', ')
      } catch (err) {
        diag(`  staging database unusable, restart fallback disabled: ${String(err)}`)
        stagingAvailable = false
        targetColumnInfo = null
        colList = null
        placeholders = null
        closeStagingDb()
        discardStagingFile()
      }
    }

    // Inspect version-dependent partition columns rather than guessing a missing identity.
    const sourceColumns = new Set(
      (sourceDb.prepare('PRAGMA table_info(cookies)').all() as ChromiumCookieColumnInfo[]).map(
        (column) => column.name
      )
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
    // An unnamed family cannot be protected from removal.
    if (nativePlan.hasUnrepresentableSkip) {
      return {
        result: {
          ok: false,
          reason:
            'Could not import: a cookie with an unreadable site partition has no registrable domain, so its existing session cannot be protected.'
        }
      }
    }

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
      ? getEncryptionKey(browser.keychainService!, browser.keychainAccount!, browser)
      : null
    if (needsSourceKey && !sourceKey) {
      return {
        result: {
          ok: false,
          reason: `Could not access ${browser.label} encryption key. The OS may have denied access.`
        }
      }
    }

    let insertStmt: ChromiumImportContext['insertStmt'] = null
    const context: ChromiumImportContext = {
      browser,
      targetPartition,
      options,
      targetSession,
      stagingCookiesPath,
      stagingAvailable,
      sourceSnapshot,
      sourceDb,
      stagingDb,
      targetColumnInfo,
      colList,
      placeholders,
      sourceColumns,
      sourceRows,
      nativePlan,
      plannedSourceRows,
      partitionBySourceRow,
      sourceKey,
      imported: 0,
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
      // Retain raw source rows for staging inserts.
      scanned: [],
      sourceDomainValidity: new Map<string, boolean>(),
      insertStmt,
      importScope: {
        exact: new Set<string>(),
        ancestors: new Set<string>(),
        descendantRoots: new Set<string>()
      },
      closeStagingDb,
      discardStagingFile,
      disableStaging: (reason: string): void => {
        diag(`  staging disabled, restart fallback unavailable: ${reason}`)
        context.stagingAvailable = false
        context.insertStmt = null
        context.closeStagingDb()
        context.discardStagingFile()
      }
    } satisfies ChromiumImportContext

    if (context.stagingDb && context.colList && context.placeholders) {
      try {
        context.insertStmt = context.stagingDb.prepare(
          `INSERT OR REPLACE INTO cookies (${context.colList}) VALUES (${context.placeholders})`
        )
        context.stagingDb.exec('BEGIN TRANSACTION')
      } catch (err) {
        context.disableStaging(String(err))
      }
    } else if (context.stagingAvailable) {
      context.disableStaging('staged database exposed no cookies columns')
    }
    // Preserve the conservative policy: partition-skipped families disable restart replay.
    if (context.nativePlan.skippedFamilies.size > 0) {
      context.disableStaging(
        `${context.nativePlan.skippedFamilies.size} preserved cookie families cannot be represented in a staged image`
      )
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
      closeStagingDb()
      discardStagingFile()
      try {
        sourceSnapshot.cleanup()
      } catch (err) {
        diag(`  Chromium snapshot cleanup failed: ${String(err)}`)
      }
    }
  }
}
