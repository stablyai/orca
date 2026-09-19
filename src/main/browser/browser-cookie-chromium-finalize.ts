import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../shared/browser-workspace-types'
import { browserSessionRegistry } from './browser-session-registry'
import { removeTransplantableCookies } from './browser-cookie-import-clear'
import { openCookieClearStore } from './browser-cookie-clear-store'
import { writeImportedCookies, type SourceCookieToWrite } from './browser-cookie-import-write'
import { deriveUrl } from './browser-cookie-validation'
import { diag } from './browser-cookie-import-diagnostics'
import type { ChromiumImportContext } from './browser-cookie-chromium-types'

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
        // Why: partition skips are a breakdown of skippedCookies, never an addition to it, so
        // totalCookies === importedCookies + skippedCookies keeps holding on this path too.
        ...(context.partitionSkipped > 0
          ? { partitionSkippedCookies: context.partitionSkipped }
          : {}),
        domains: [],
        // Why: a profile whose rows cannot be decrypted returns here, and without this it is
        // reported as a successful empty import.
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

  // Why: clear stale cookies for the domains being imported first; mixing them with the imported
  // set makes sites reject the session. Non-transplantable families are exempt — nothing was
  // imported for them, and their live session is the only one that works.
  // Why (STA-4797): every other site in the partition is exempt too. The rationale above reaches
  // only as far as the domains this import writes; beyond them a clear has nothing to reconcile
  // and only signs the user out of sessions the import was never about.
  // Why (STA-4300): one store spans the clear and the writes, so both halves of the import speak
  // the same CDP identities — cookies.set() cannot express the partition either one reads.
  const cookieClearStore = openCookieClearStore(context.targetSession)
  try {
    // Why (STA-4601): the outer lock spans the clear and the writes that repopulate the jar, so a
    // second import cannot clear between them and write on top of a newer import's jar.
    await removeTransplantableCookies(
      {
        cookies: cookieClearStore,
        snapshotClearIdentities: (cookies) => cookieClearStore.snapshotClearIdentities(cookies),
        restoreClearIdentities: (identities) => cookieClearStore.restoreClearIdentities(identities)
      },
      // Why (STA-4300): the families this import declined to write must not be removed either.
      // Passing them here keeps their coordinates out of the removal plan AND out of the CDP
      // snapshot taken from it, so they are never submitted to any mutation.
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
    // Why: a rejected cookie here falls back to the staged cold-start replay rather than
    // unwinding the import, so one failure must not stop the rest from loading.
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
    // Why: keep the staging DB so the failed cookies load from SQLite on next cold start, where CookieMonster skips validation.
    browserSessionRegistry.setPendingCookieImport(
      context.targetPartition,
      context.stagingCookiesPath
    )
    diag(
      `  staged at ${context.stagingCookiesPath} for ${context.memoryFailed} cookies that need restart`
    )
  } else if (context.memoryFailed > 0) {
    // Why: never register a path that was never written or can never be replayed — cold start
    // would replay a missing or partial DB over the live partition.
    browserSessionRegistry.clearPendingCookieImport(context.targetPartition)
    context.discardStagingFile()
    diag(`  ${context.memoryFailed} cookies need a restart but staging is unavailable — skipped`)
    // Why: the jar was already cleared, so silence here would report a lossy import as a clean success.
    warning = {
      code: 'restart-fallback-unavailable',
      loadedCookies: context.memoryLoaded,
      failedCookies: context.memoryFailed
    }
  } else {
    // Why: this import already rewrote the live session, so an older staged DB must not replay over it.
    browserSessionRegistry.clearPendingCookieImport(context.targetPartition)
    context.discardStagingFile()
    diag('  all cookies loaded in-memory — no restart needed')
  }

  // Why: the session keeps the UA the registry set at startup (clean or native).
  // Imports must not impersonate the source browser — the synthesized UA read a
  // fork's marketing version as a Chromium version (STA-3514), and Google binds
  // sessions to the re-import, not the UA (#12884), so it bought nothing.
  // Google-bound integrity cookies are already excluded by
  // isGoogleSourceBoundCookie, which is what actually prevents CookieMismatch.

  // Why: a partial import still drops every undecryptable row, so silence here would report it
  // as an unqualified success. The restart-fallback warning describes a lossier outcome and
  // keeps precedence.
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
    ...(context.partitionSkipped > 0 ? { partitionSkippedCookies: context.partitionSkipped } : {}),
    domains: [...context.domainSet].sort(),
    ...(warning ? { warning } : {})
  }
  return { ok: true, profileId: '', summary }
}
