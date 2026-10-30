import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

export type CodexSessionBackfillSummary = {
  stopped: boolean
  scannedFiles: number
  linkedFiles: number
  copiedFiles: number
  skippedExistingFiles: number
  skippedUnexpectedFiles: number
  skippedSymlinkFiles: number
  skippedUnsupportedFilesystemFiles: number
  failedDirectories: number
  failedFiles: number
  failedHealAuditRecords: number
}

export type CodexSessionBackfillPaths = {
  managedSessionsRoot: string
  systemSessionsRoot: string
  auditLogPath: string
  markerPath: string
}

export type CodexSessionBackfillOptions = CodexSessionBridgeIncrementalOptions & {
  /** Polled between file mutations, preserving progress on opt-out. */
  shouldStop?: () => boolean
  scanDates?: readonly CodexSessionBackfillDate[]
  fullScanRequired?: boolean
  /** Scheduled launch passes still publish new rollouts when nothing is pending. */
  ignoreCompletionMarker?: boolean
  /** Keep dates pending while a live pane can still write into them. */
  retainPendingScanDates?: boolean
  /** Recheck scheduling after async writes, before certifying completion. */
  canWriteCompletionMarker?: () => boolean
}

export type CodexSessionBackfillDate = readonly [year: string, month: string, day: string]
