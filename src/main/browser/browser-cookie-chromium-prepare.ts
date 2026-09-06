import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import { supportsPendingBrowserCookieImportReplay } from './browser-session-cookie-staging'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain
} from './browser-cookie-import-policy'
import { createChromiumCookieSnapshot } from './chromium-cookie-snapshot'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'
import { copyFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import { planImportWrites } from './browser-cookie-import-write'
import { readChromiumRowPartition } from './browser-cookie-source-partition'
import { diag } from './browser-cookie-import-diagnostics'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import type { CookieImportOptions } from './browser-cookie-import-pipeline'
import type { ChromiumCookieColumnInfo } from './browser-cookie-sqlite'
import type { ChromiumImportContext } from './browser-cookie-chromium-types'
import type { Session } from 'electron'
import { getEncryptionKey } from './browser-cookie-key'

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
  // Why (STA-4300): ask the Session where its own storage lives instead of rebuilding the path from
  // the caller's partition string. String surgery on a caller-supplied name is what let a value like
  // "persist:../.." resolve a Cookies DB outside the Partitions directory and stage a replacement
  // over it; it also drifts whenever Chromium changes how a partition name maps to a directory.
  const partitionDir = targetSession.getStoragePath()
  if (!partitionDir) {
    return {
      result: { ok: false, reason: 'Target cookie database not found. Open a browser tab first.' }
    }
  }

  const partitionName = targetPartition.replace('persist:', '')
  let liveCookiesPath = resolveChromiumCookiesPath(partitionDir)
  // Why: Electron creates the Cookies file only after a cookie is stored; a throwaway set/remove forces DB init for unused profiles.
  // Why (STA-4601): this probe MUTATES the live jar, so it runs under the same per-partition lock as
  // the import itself. An earlier revision left it outside on the argument that no import writes
  // https://localhost/__init — that was wrong. normalizeCookieImportDomain accepts `localhost`,
  // cookie names are unrestricted, and deriveUrl produces exactly this URL, so an import CAN write
  // that coordinate. Unlocked, this probe's remove() would delete a cookie a concurrent import had
  // just written and reported as imported. The cost is negligible: the probe only runs for a
  // partition that has never stored a cookie, so it is at most a one-time wait per profile.
  if (!liveCookiesPath) {
    try {
      await targetSession.cookies.set({ url: 'https://localhost', name: '__init', value: '1' })
      await targetSession.cookies.remove('https://localhost', '__init')
      await targetSession.cookies.flushStore()
    } catch {
      // ignore — the set/remove may fail but flushStore should still create the file
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
  // Why: #9355 — staging only backs the cold-restart replay for cookies the in-memory
  // import rejects, so losing it must degrade that fallback rather than abort the import.
  let stagingAvailable = false
  // Why: a client-hosted route partition is derived at runtime and never reaches the startup
  // replay, so staging it would only leave a plaintext cookie DB nothing ever consumes.
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
      // Why: copyFile is non-atomic and can leave a partial DB; delete it so failed imports retain no cookie data.
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
    }
  }

  let sourceSnapshot: ReturnType<typeof createChromiumCookieSnapshot>
  try {
    // Why: an open browser may hold cookies in WAL only; snapshot retries avoid pairing the main DB with a racing WAL.
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
    // Why: the staged copy holds plaintext cookie values, and SQLite may have left sidecars beside it.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(stagingCookiesPath + suffix)
      } catch {
        /* best-effort */
      }
    }
  }

  // Why: Chromium timestamps (µs since 1601) can exceed Number.MAX_SAFE_INTEGER; readBigInts avoids precision loss.
  sourceDb = new DatabaseSync(sourceSnapshot.databasePath, { readOnly: true, readBigInts: true })
  let targetColumnInfo: ChromiumCookieColumnInfo[] | null = null
  let colList: string | null = null
  let placeholders: string | null = null
  if (stagingAvailable) {
    // Why: the staged file is Orca's own partition DB, also named "Cookies", so the same
    // transient AV handle can make opening it throw — degrade instead of killing the import.
    try {
      stagingDb = new DatabaseSync(stagingCookiesPath)
      // Why (STA-4797): a new-format stage must be one self-contained file. Otherwise a lost WAL
      // can erase its scope marker and make cold-start replay mistake it for a legacy whole-image
      // import, restoring the unrelated-cookie data loss this format is meant to prevent.
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
      // Why: the copy holds real partition cookies; discard it now rather than at the exit branches.
      discardStagingFile()
    }
  }

  // Why (STA-4300): the partition columns drift across Chromium versions, so read the source
  // schema rather than assuming a row's missing column means "unpartitioned".
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
    closeStagingDb()
    discardStagingFile()
    return { result: { ok: false, reason: `No cookies found in ${browser.label}.` } }
  }

  // Why (STA-4300): partition fidelity is a property of the source row, even when its value
  // cannot be decrypted. Plan first so decryption failure cannot discard a family's skip.
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
  // Why (§4.3c): a family we cannot name is one we cannot exclude from the clear, and clearing a
  // family we cannot protect is the P0. Refuse before the jar is touched.
  if (nativePlan.hasUnrepresentableSkip) {
    closeStagingDb()
    discardStagingFile()
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
    closeStagingDb()
    // Why: key denial happens after staging, so clean up the target DB copy or retries pile up.
    discardStagingFile()
    return {
      result: {
        ok: false,
        reason: `Could not access ${browser.label} encryption key. The OS may have denied access.`
      }
    }
  }

  // Why: staging only backs the cold-restart replay, so any failure writing it disables that
  // fallback instead of aborting an import whose in-memory half still works.
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
    // Why: the staging insert needs the RAW source row, so each scanned candidate carries it.
    // A plan record holding only the derived fields compiles fine and then cannot stage.
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
  // Why: keep the existing conservative fallback boundary for family-level omissions. Expanding
  // partial-import restart behavior is separate from narrowing what a staged replay may replace.
  if (context.nativePlan.skippedFamilies.size > 0) {
    context.disableStaging(
      `${context.nativePlan.skippedFamilies.size} preserved cookie families cannot be represented in a staged image`
    )
  }
  return { context }
}
