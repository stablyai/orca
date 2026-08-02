// Aggregate provider contract surface. The three per-domain contracts live in
// their own files; this barrel keeps every historical `providers/types` import
// path working.

// ─── PTY Provider ───────────────────────────────────────────────────

export type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyDataEvent,
  PtyProcessInfo,
  PtyProviderBufferSnapshot,
  PtySpawnOptions,
  PtySpawnResult,
  PtyTransientFact
} from './pty-provider-contract'

// ─── Filesystem Provider ────────────────────────────────────────────

export type {
  FileReadResult,
  FileStat,
  FileUploadSession,
  IFilesystemProvider,
  TerminalArtifactAccessOptions
} from './filesystem-provider-contract'

// ─── Git Provider ───────────────────────────────────────────────────

export type { GitProviderStatusOptions, IGitProvider } from './git-provider-contract'
