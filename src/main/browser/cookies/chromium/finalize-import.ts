import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../../../shared/browser-workspace-types'
import { browserSessionRegistry } from '../../browser-session-registry'
import { summarizePartitionSkips } from '../browser-cookie-partition-summary'
import { removeTransplantableCookies } from '../browser-cookie-import-clear'
import { openCookieClearStore } from '../browser-cookie-clear-store'
import { writeImportedCookies, type SourceCookieToWrite } from '../browser-cookie-import-write'
import { deriveUrl } from '../sources/browser-cookie-validation'
import { diag } from '../browser-cookie-import-diagnostics'
import type { ChromiumImportContext } from './import-context'

export async function finalizeChromiumCookieImport(
  context: ChromiumImportContext
): Promise<BrowserCookieImportResult> {
  if (context.decryptedCookies.length === 0) {
    const zeroPathWarning = context.undecryptableWarning
    context.closeStagingDb()
    context.discardStagingFile()
    return {
      ok: true,
      profileId: '',
      summary: {
        totalCookies: context.sourceRows.length,
        importedCookies: 0,
        skippedCookies:
          context.skipped + context.integritySkipped + context.nonTransplantableSkipped,
        ...(context.googleCookiesSkipped > 0
          ? { googleCookiesSkipped: context.googleCookiesSkipped }
          : {}),
        ...summarizePartitionSkips(context.nativePlan.skips),
        domains: [],
        // An undecryptable profile must not appear to be a successful empty import.
        ...(zeroPathWarning ? { warning: zeroPathWarning } : {})
      }
    }
  }

  if (context.stagingDb) {
    try {
      context.stagingDb.exec('COMMIT')
      context.closeStagingDb()
      diag(
        `  SQLite staging complete: ${context.imported} cookies, ${context.domainSet.size} domains`
      )
    } catch (err) {
      context.disableStaging(String(err))
    }
  } else {
    diag(`  staging skipped: ${context.imported} cookies will load in-memory only`)
  }

  // Use one CDP store for scoped removal and writes so both retain partition identities.
  const cookieClearStore = openCookieClearStore(context.targetSession)
  try {
    await removeTransplantableCookies(
      {
        cookies: cookieClearStore,
        snapshotClearIdentities: (cookies) => cookieClearStore.snapshotClearIdentities(cookies),
        restoreClearIdentities: (identities) => cookieClearStore.restoreClearIdentities(identities)
      },
      // Skipped families must remain outside both removal and rollback snapshots.
      context.nativePlan.skippedFamilies,
      context.importScope
    )
    diag(
      `  cleared existing cookies for ${context.domainSet.size} imported domains before loading ${context.decryptedCookies.length} imported cookies`
    )

    const writable: SourceCookieToWrite[] = []
    for (const cookie of context.decryptedCookies) {
      const url = deriveUrl(cookie.domain, cookie.secure)
      if (!url) {
        context.memoryFailed++
        continue
      }
      writable.push({ ...cookie, url })
    }
    // Continue live writes; rejected cookies may use staged cold-start replay.
    const phase = await writeImportedCookies(cookieClearStore, writable, {
      stopOnFailure: false,
      log: diag
    })
    context.memoryLoaded = phase.importedCount
    context.memoryFailed += phase.writeRejected
  } finally {
    cookieClearStore.dispose()
  }

  diag(
    `  memory load: ${context.memoryLoaded} OK, ${context.memoryFailed} failed, ${context.partitionSkipped} partition-unreadable`
  )

  let warning: BrowserCookieImportSummary['warning']
  if (context.memoryFailed > 0 && context.stagingAvailable) {
    // Retain the staged file for cold-start replay of cookies rejected by live writes.
    browserSessionRegistry.setPendingCookieImport(
      context.targetPartition,
      context.stagingCookiesPath
    )
    diag(
      `  staged at ${context.stagingCookiesPath} for ${context.memoryFailed} cookies that need restart`
    )
  } else if (context.memoryFailed > 0) {
    // An unavailable staged file cannot safely back cold-start replay.
    browserSessionRegistry.clearPendingCookieImport(context.targetPartition)
    context.discardStagingFile()
    diag(`  ${context.memoryFailed} cookies need a restart but staging is unavailable — skipped`)
    // Removal already ran, so report cookies that neither live writes nor replay can restore.
    warning = {
      code: 'restart-fallback-unavailable',
      loadedCookies: context.memoryLoaded,
      failedCookies: context.memoryFailed
    }
  } else {
    // A stale staged image must not overwrite this successful live import.
    browserSessionRegistry.clearPendingCookieImport(context.targetPartition)
    context.discardStagingFile()
    diag('  all cookies loaded in-memory — no restart needed')
  }

  // Report decryption loss unless the more severe restart-fallback warning already applies.
  if (!warning && context.undecryptableWarning) {
    warning = context.undecryptableWarning
  }

  const summary: BrowserCookieImportSummary = {
    totalCookies: context.sourceRows.length,
    importedCookies: context.imported,
    skippedCookies: context.skipped + context.integritySkipped + context.nonTransplantableSkipped,
    ...(context.googleCookiesSkipped > 0
      ? { googleCookiesSkipped: context.googleCookiesSkipped }
      : {}),
    ...summarizePartitionSkips(context.nativePlan.skips),
    domains: [...context.domainSet].sort(),
    ...(warning ? { warning } : {})
  }
  return { ok: true, profileId: '', summary }
}
