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
  /** Forces recertification of the whole tree, ignoring any existing baseline. */
  fullScanRequired?: boolean
  /** A scheduled launch pass runs even when the baseline reports nothing pending. */
  ignoreCompletionMarker?: boolean
  /** A live Codex pane keeps writing into its own date, so it stays pending. */
  retainPendingScanDates?: boolean
  /** Rechecks launch scheduling state immediately before marker publication. */
  canWriteCompletionMarker?: () => boolean
}

export type CodexSessionBackfillDate = readonly [year: string, month: string, day: string]
