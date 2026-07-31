// Aggregate provider contract surface. The three per-domain contracts live in
// their own files; this barrel keeps every historical `providers/types` import
// path working and owns the registry that ties them together.
import type { IPtyProvider } from './pty-provider-contract'
import type { IFilesystemProvider } from './filesystem-provider-contract'
import type { IGitProvider } from './git-provider-contract'

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

// ─── Provider Registry ──────────────────────────────────────────────

/** Routes operations by connectionId; null/undefined selects the local provider. */
export type IProviderRegistry = {
  getPtyProvider(connectionId: string | null | undefined): IPtyProvider
  getFilesystemProvider(connectionId: string | null | undefined): IFilesystemProvider
  getGitProvider(connectionId: string | null | undefined): IGitProvider
}
