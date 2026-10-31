import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

/**
 * Whether a background session migration must skip the host source home now. A `\\wsl.localhost`
 * path typed into that setting is read over 9P, which boots a stopped distro (E9).
 */
export async function isCodexSessionSourceHomeBlocked(sourceHome?: string): Promise<boolean> {
  return sourceHome ? (await blockedWslDistroForPath(sourceHome)) !== null : false
}

/** A stopped summary while the source home is blocked: the scheduler keeps its dates pending and skips the index heal. */
export async function skippedBackfillForBlockedSourceHome(
  sourceHome?: string
): Promise<CodexSessionBackfillSummary | null> {
  if (!(await isCodexSessionSourceHomeBlocked(sourceHome))) {
    return null
  }
  return {
    stopped: true,
    scannedFiles: 0,
    linkedFiles: 0,
    copiedFiles: 0,
    skippedExistingFiles: 0,
    skippedUnexpectedFiles: 0,
    skippedSymlinkFiles: 0,
    skippedUnsupportedFilesystemFiles: 0,
    failedDirectories: 0,
    failedFiles: 0,
    failedHealAuditRecords: 0
  }
}
