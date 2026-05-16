import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { readFile } from 'fs/promises'

const SESSION_PREVIEW_TEXT_LIMIT = 220

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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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

export function extractGitBranch(value: unknown): string | null {
  const git = asRecord(value)
  if (!git) {
    return null
  }
  return extractString(git.branch) || extractString(git.current_branch)
}

export function extractMessageText(value: unknown): string | null {
  const message = asRecord(value)
  if (!message) {
    return null
  }
  return extractContentText(message.content)
}

export function extractContentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return normalizeTitleText(value)
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) || extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return normalizeTitleText(parts.join(' '))
}

export function normalizeTitleText(value: string): string | null {
  const withoutReminders = value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!withoutReminders) {
    return null
  }
  if (/^# AGENTS\.md instructions for\b/i.test(withoutReminders)) {
    return null
  }
  if (/^<INSTRUCTIONS>/i.test(withoutReminders)) {
    return null
  }
  return withoutReminders.length > 96 ? `${withoutReminders.slice(0, 93)}...` : withoutReminders
}

export function extractPreviewContentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return normalizePreviewText(value)
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) || extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return normalizePreviewText(parts.join(' '))
}

export function normalizePreviewText(value: string): string | null {
  const normalized = value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) {
    return null
  }
  if (/^# AGENTS\.md instructions for\b/i.test(normalized) || /^<INSTRUCTIONS>/i.test(normalized)) {
    return null
  }
  return normalized.length > SESSION_PREVIEW_TEXT_LIMIT
    ? `${normalized.slice(0, SESSION_PREVIEW_TEXT_LIMIT - 3)}...`
    : normalized
}

export async function readJsonObjectIfExists(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await readFile(filePath, 'utf-8')) as unknown)
  } catch {
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

export function normalizePiSessionsDir(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return join(homedir(), '.pi', 'agent', 'sessions')
  }
  const normalized = trimmed.replace(/[\\/]+$/, '')
  const leaf = basename(normalized)
  if (leaf === 'sessions') {
    return normalized
  }
  if (leaf === 'agent') {
    return join(normalized, 'sessions')
  }
  if (leaf === '.pi') {
    return join(normalized, 'agent', 'sessions')
  }
  return normalized
}

export function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export {
  claudeUsageTotal,
  copilotModelMetricsTotal,
  normalizeCodexUsage,
  numberValue,
  subtractCodexUsage,
  tokenTotal
} from './session-scanner-token-values'
