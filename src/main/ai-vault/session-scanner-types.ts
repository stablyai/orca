import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSessionPreviewMessage
} from '../../shared/ai-vault-types'

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
  droidSessionsDir?: string
  droidProjectsDir?: string
  kimiSessionsDir?: string
  codeWhaleSessionsDir?: string
  limit?: number
  limitPerAgent?: number
  // Active workspace/project paths whose sessions must be included regardless of
  // the recency cap (see discoverInScopeClaudeFiles).
  scopePaths?: readonly string[]
  platform?: NodeJS.Platform
}

export type FileWithMtime = {
  path: string
  mtimeMs: number
  modifiedAt: string
}

export type SessionFileCandidate = {
  agent: AiVaultAgent
  file: FileWithMtime
  codexHome: string | null
  codeWhaleHome?: string | null
}

export type SessionFileDiscovery = {
  agent: AiVaultAgent
  rootDir: string
  files: FileWithMtime[]
  codeWhaleHome?: string | null
}

export type SessionParseResult = {
  session: AiVaultSession | null
  issue: AiVaultScanIssue | null
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
