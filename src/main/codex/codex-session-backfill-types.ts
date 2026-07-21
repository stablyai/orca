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
}
