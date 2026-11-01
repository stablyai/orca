import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../../../shared/browser-workspace-types'
import { browserSessionRegistry } from '../../browser-session-registry'
import { summarizePartitionSkips } from '../browser-cookie-partition-summary'
import { openCookieClearStore } from '../browser-cookie-clear-store'
import { writeImportedCookies, type SourceCookieToWrite } from '../browser-cookie-import-write'
import { deriveUrl } from '../sources/browser-cookie-validation'
import { diag } from '../browser-cookie-import-diagnostics'
import type { ChromiumImportContext } from './import-context'

export async function finalizeChromiumCookieImport(
  context: ChromiumImportContext,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  if (context.decryptedCookies.length === 0) {
    const zeroPathWarning = context.undecryptableWarning
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

  const cookieClearStore = openCookieClearStore(context.targetSession)
  try {
    const writable: SourceCookieToWrite[] = []
    for (const cookie of context.decryptedCookies) {
      const url = deriveUrl(cookie.domain, cookie.secure)
      if (!url) {
        context.memoryFailed++
        continue
      }
      writable.push({ ...cookie, url })
    }
    // Rejections leave other coordinates available for the remaining live writes.
    const phase = await writeImportedCookies(cookieClearStore, writable, {
      log: diag
    })
    context.memoryLoaded = phase.importedCount
    context.domainSet = phase.domains
    context.memoryFailed += phase.writeRejected
    context.skipped += phase.expired
  } finally {
    cookieClearStore.dispose()
  }

  browserSessionRegistry.clearPendingCookieImport(targetPartition)

  diag(
    `  memory load: ${context.memoryLoaded} OK, ${context.memoryFailed} failed, ${context.partitionSkipped} partition-unreadable`
  )

  const summary: BrowserCookieImportSummary = {
    totalCookies: context.sourceRows.length,
    importedCookies: context.memoryLoaded,
    skippedCookies:
      context.skipped +
      context.integritySkipped +
      context.nonTransplantableSkipped +
      context.memoryFailed,
    ...(context.googleCookiesSkipped > 0
      ? { googleCookiesSkipped: context.googleCookiesSkipped }
      : {}),
    ...summarizePartitionSkips(context.nativePlan.skips),
    domains: [...context.domainSet].sort(),
    ...(context.undecryptableWarning ? { warning: context.undecryptableWarning } : {})
  }
  return { ok: true, profileId: '', summary }
}
