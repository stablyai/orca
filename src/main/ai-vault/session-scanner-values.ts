import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { asRecord } from './session-scanner-record-value'

export { asRecord }

export function timestampMs(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.NaN
  }
  return value > 1_000_000_000_000 ? value : value * 1000
}

export function parseJsonObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(line) as unknown
    return asRecord(parsed)
  } catch {
    return null
  }
}

export function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function extractModel(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  return (
    extractString(record.model) ||
    extractString(record.model_name) ||
    extractString(asRecord(record.metadata)?.model) ||
    extractString(asRecord(record.info)?.model) ||
    null
  )
}

export {
  extractContentText,
  extractMessageText,
  extractPreviewContentText,
  normalizePreviewText,
  normalizeTitleText,
  sliceAtCodeUnitLimit
} from './session-scanner-text-normalization'
export {
  extractFullFirstUserPromptText,
  normalizeFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'

export function extractGitBranch(value: unknown): string | null {
  const git = asRecord(value)
  if (!git) {
    return null
  }
  return extractString(git.branch) || extractString(git.current_branch)
}

export async function readJsonObjectIfExists(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await wslGatedReadFile(filePath, 'utf-8', 'scan')) as unknown)
  } catch (error) {
    // A missing or malformed file is genuinely "no enrichment", but a gate
    // refusal must reach `parseSessionCandidate` as an issue — degrading it to
    // null caches the un-enriched session under an unchanged mtime, and the
    // non-resumable agents that use this never re-read it.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
  }
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = extractString(record[key])
    if (value) {
      return value
    }
  }
  return null
}

export function extractTrustedFolder(value: unknown): string | null {
  const message = extractString(value)
  if (!message) {
    return null
  }
  return message.match(/^Folder (.+) has been added to trusted folders\.$/)?.[1] ?? null
}

export function timeObjectValue(value: unknown, key: string): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const rawValue = record[key]
  if (typeof rawValue === 'string') {
    return rawValue
  }
  const parsed = timestampMs(rawValue)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return new Date(parsed).toISOString()
}

export function findOpenCodeStorageRoot(filePath: string): string | null {
  const sessionDir = dirname(filePath)
  const sessionRoot = dirname(sessionDir)
  if (basename(sessionRoot) !== 'session') {
    return null
  }
  return dirname(sessionRoot)
}

// Pi and OMP (a Pi fork) both store transcripts under
// <home>/<agentHomeDirName>/agent/sessions; accept any prefix of that path.
export function normalizeAgentSessionsDir(
  rawValue: string,
  agentHomeDirName: '.pi' | '.omp'
): string {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return join(homedir(), agentHomeDirName, 'agent', 'sessions')
  }
  const normalized = trimmed.replace(/[\\/]+$/, '')
  const leaf = basename(normalized)
  if (leaf === 'sessions') {
    return normalized
  }
  if (leaf === 'agent') {
    return join(normalized, 'sessions')
  }
  if (leaf === agentHomeDirName) {
    return join(normalized, 'agent', 'sessions')
  }
  return normalized
}

function defaultPrimeAgentSessionsDir(): string {
  return join(homedir(), '.prime', 'agent', 'sessions')
}

// Why: the CLI expands a leading `~` itself, so a value set outside a shell
// (config file, plist, quoted assignment) still resolves against the home dir.
// Returns null for anything that is not an absolute root, since a relative value
// ('', '.', '..', 'sessions') would resolve against the main-process cwd.
function absoluteConfiguredDir(rawValue: string): string | null {
  const expanded = rawValue === '~' ? homedir() : rawValue.replace(/^~(?=[\\/])/, homedir())
  const normalized = expanded.replace(/[\\/]+$/, '')
  return normalized && isAbsolute(normalized) ? normalized : null
}

// Prime Agent takes PRIME_AGENT_CODING_AGENT_DIR verbatim as its agent config dir
// (no `/agent` suffixing) and always writes transcripts to `<agentDir>/sessions` —
// unconditionally, so a root that is itself named `sessions` still nests one deeper.
export function normalizePrimeAgentSessionsDir(rawAgentDir: string): string {
  const agentDir = absoluteConfiguredDir(rawAgentDir.trim())
  return agentDir ? join(agentDir, 'sessions') : defaultPrimeAgentSessionsDir()
}

// PRIME_AGENT_SESSION_DIR (and its legacy PRIME_AGENT_CODING_AGENT_SESSION_DIR alias)
// point straight at the transcripts root and outrank the agent dir upstream, so they
// are used verbatim with no `sessions` child.
export function primeAgentSessionsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const sessionDir =
    env.PRIME_AGENT_SESSION_DIR?.trim() || env.PRIME_AGENT_CODING_AGENT_SESSION_DIR?.trim()
  if (sessionDir) {
    return absoluteConfiguredDir(sessionDir) ?? defaultPrimeAgentSessionsDir()
  }
  const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR?.trim()
  return agentDir ? normalizePrimeAgentSessionsDir(agentDir) : defaultPrimeAgentSessionsDir()
}

export function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export {
  addCodexUsage,
  claudeUsageTotal,
  copilotModelMetricsTotal,
  normalizeCodexUsage,
  numberValue,
  subtractCodexUsage,
  tokenTotal
} from './session-scanner-token-values'
