import type {
  AiVaultAgent,
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSessionPreviewMessage
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  TranscriptMessageSink,
  TranscriptSessionIdentity
} from './session-transcript-consumers'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { OpenCodeWslRuntime } from './session-scanner-opencode-wsl-runtime'

export type AiVaultScanOptions = {
  claudeProjectsDir?: string
  /** Account `projects` folders the System default does not link; resolved by the host process. */
  claudeProfileProjectsDirs?: readonly string[]
  codebuddyProjectsDir?: string
  qoderProjectsDir?: string
  codexSessionsDir?: string
  additionalCodexSessionsDirs?: readonly string[]
  // Override the default Codex home to test unprefixed resume commands without reading user data.
  defaultCodexHomeDir?: string
  wslHomeDirs?: readonly string[]
  wslOpenCodeReaders?: readonly OpenCodeWslRuntime[]
  geminiSessionsDir?: string
  antigravityBrainDir?: string
  antigravityAppHome?: string
  includeAntigravityIdeSessions?: boolean
  copilotSessionsDir?: string
  cursorProjectsDir?: string
  opencodeStorageDir?: string
  opencodeDbPaths?: readonly string[]
  zcodeDbPath?: string
  grokSessionsDir?: string
  devinTranscriptsDir?: string
  hermesSessionsDir?: string
  rovoSessionsDir?: string
  openclawStateDir?: string
  openclawLegacyStateDir?: string
  piSessionsDir?: string
  ompSessionsDir?: string
  primeAgentSessionsDir?: string
  droidSessionsDir?: string
  droidProjectsDir?: string
  clineSessionsDir?: string
  kimiSessionsDir?: string
  museSessionsDir?: string
  jcodeSessionsDir?: string
  kiroSessionsDir?: string
  limit?: number
  unlimited?: boolean
  limitPerAgent?: number
  // Include sessions for these workspace paths beyond the recency cap (AI_VAULT_SCOPE_CWD_SOURCES).
  scopePaths?: readonly string[]
  platform?: NodeJS.Platform
  executionHostId?: ExecutionHostId
  signal?: AbortSignal
}

export type FileWithMtime = {
  /** Antigravity alias observation, separate from the actual file stat/cache key. */
  aliasMtimeMs?: number
  path: string
  mtimeMs: number
  modifiedAt: string
  // Discovery’s transcript byte length avoids restats; synthetic database rows omit it.
  sizeBytes?: number
  sidecar?: SessionSidecarObservation
  // Codex dual-root scans use filesystem identity to deduplicate hardlink aliases.
  dev?: number
  ino?: number
  nlink?: number
}

export type SessionFileCandidate = {
  agent: AiVaultAgent
  file: FileWithMtime
  codexHome: string | null
  antigravityHistoryPath?: string
}

export type SessionFileDiscovery = {
  agent: AiVaultAgent
  rootDir: string
  files: FileWithMtime[]
  // Discovered beyond `files`, kept only for a scoped scan's in-scope walk.
  scopeFiles?: FileWithMtime[]
}

export type SessionParseResult = {
  session: AiVaultSession | null
  issue: AiVaultScanIssue | null
}

export type ResumableParseFinalizeOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// clone() must isolate mutable fold state so failed or display-only reads cannot corrupt the cache.
export type ResumableSessionParseState = {
  consumeLine(line: string): void
  // Reject irrelevant records by bounded byte prefix before decoding large JSONL lines.
  consumeLineBytes?(line: Buffer): void
  shouldStop?(): boolean
  // Expose identity to consumers that commit before the transcript read ends.
  identity?(): TranscriptSessionIdentity | null
  clone(): ResumableSessionParseState
  touchFile(file: FileWithMtime): void
  finalize(
    platform: NodeJS.Platform,
    options?: ResumableParseFinalizeOptions
  ): Promise<AiVaultSession | null> | AiVaultSession | null
}

export type SessionAccumulator = {
  agent: AiVaultAgent
  // Clones share the sink so one transcript read produces one message stream.
  messages: TranscriptMessageSink
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
  // The earliest retained preview is no longer the opening turn.
  previewMessagesTruncated: boolean
  antigravityOpeningPrompt?: AiVaultSession['antigravityOpeningPrompt'] | null
  firstUserPrompt: string | null
  lastUserPrompt: string | null
  // Recoverable signal for a zero-turn transcript (see AiVaultSession).
  queuedMessageCount: number
  subagentTranscriptCount: number
  earliestTimestampMs: number
  latestTimestampMs: number
}

export type CodexUsageSnapshot = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}
