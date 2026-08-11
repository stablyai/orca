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
  /** Polled before each target mutation; true stops with progress preserved. */
  shouldStop?: () => boolean
  /** Limits a launch-triggered pass to the date directories that can contain its rollouts. */
  scanDates?: readonly CodexSessionBackfillDate[]
  /** A scheduled launch pass must not be suppressed by a marker it just invalidated. */
  ignoreCompletionMarker?: boolean
  /** Active launch passes defer global completion until their final exit scan. */
  writeCompletionMarker?: boolean
  /** Final launch scans can extend a previously certified full-tree baseline. */
  writeBoundedCompletionMarker?: boolean
  /** Rechecks launch scheduling state immediately before marker publication. */
  canWriteCompletionMarker?: () => boolean
}

export type CodexSessionBackfillDate = readonly [year: string, month: string, day: string]
