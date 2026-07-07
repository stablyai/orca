import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSessionPreviewMessage
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'

export type AiVaultScanOptions = {
  claudeProjectsDir?: string
  codexSessionsDir?: string
  additionalCodexSessionsDirs?: readonly string[]
  wslHomeDirs?: readonly string[]
  geminiSessionsDir?: string
  copilotSessionsDir?: string
  cursorProjectsDir?: string
  opencodeStorageDir?: string
  // Why: OpenCode 1.17.x stores sessions in SQLite; tests inject a temp DB
  // here so they don't depend on the real ~/.local/share/opencode.
  opencodeDbPaths?: readonly string[]
  grokSessionsDir?: string
  devinTranscriptsDir?: string
  hermesSessionsDir?: string
  rovoSessionsDir?: string
  openclawStateDir?: string
  openclawLegacyStateDir?: string
  piSessionsDir?: string
  ompSessionsDir?: string
  droidSessionsDir?: string
  droidProjectsDir?: string
  kimiSessionsDir?: string
  limit?: number
  limitPerAgent?: number
  // Active workspace/project paths whose sessions must be included regardless of
  // the recency cap (see discoverInScopeClaudeFiles).
  scopePaths?: readonly string[]
  platform?: NodeJS.Platform
  executionHostId?: ExecutionHostId
}

export type FileWithMtime = {
  path: string
  mtimeMs: number
  modifiedAt: string
  // Present when discovery statted the file; lets the parse cache detect
  // unchanged/truncated files without a second stat. Synthetic candidates
  // (OpenCode SQLite rows, remote files) omit it.
  sizeBytes?: number
}

export type SessionFileCandidate = {
  agent: AiVaultAgent
  file: FileWithMtime
  codexHome: string | null
}

export type SessionFileDiscovery = {
  agent: AiVaultAgent
  rootDir: string
  files: FileWithMtime[]
}

export type SessionParseResult = {
  session: AiVaultSession | null
  issue: AiVaultScanIssue | null
}

export type ResumableParseFinalizeOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// One in-progress parse of an append-only transcript, resumable across scans.
// The parse cache stores a state per file and feeds it only newly appended
// lines; `clone` must deep-copy anything `consumeLine` mutates so a failed
// read or a display-only trailing line can never corrupt the cached fold.
export type ResumableSessionParseState = {
  consumeLine(line: string): void
  clone(): ResumableSessionParseState
  // Refresh per-scan file metadata (mtime display string) without re-parsing.
  touchFile(file: FileWithMtime): void
  finalize(
    platform: NodeJS.Platform,
    options?: ResumableParseFinalizeOptions
  ): Promise<AiVaultSession | null> | AiVaultSession | null
}

export type SessionAccumulator = {
  agent: AiVaultAgent
  sessionId: string
  title: string | null
  fallbackTitle: string | null
  cwd: string | null
  branch: string | null
  model: string | null
  filePath: string
  createdAt: string | null
  updatedAt: string | null
  modifiedAt: string
  messageCount: number
  totalTokens: number
  previewMessages: AiVaultSessionPreviewMessage[]
  latestTimestampMs: number
}

export type CodexUsageSnapshot = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}
