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
  limit?: number
  limitPerAgent?: number
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
