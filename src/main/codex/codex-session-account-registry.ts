import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getOrcaUserDataPath } from './codex-home-paths'

/**
 * Durable account snapshot for Codex provider sessions.
 *
 * Session rollouts are hardlinked into every managed account home so their
 * filesystem path is not trustworthy account evidence. The live hook gives us
 * the provider session id while the PTY registry still knows its launch
 * account; this registry preserves that one authoritative association after
 * the PTY exits.
 */

export type CodexSessionAccountRecord = {
  /** Managed account id, or null for the system-default Codex login. */
  accountId: string | null
  observedAt: number
}

type RegistryFile = {
  version: 1
  sessions: Record<string, CodexSessionAccountRecord>
}

const MAX_TRACKED_SESSIONS = 10_000
const MAX_SESSION_ID_LENGTH = 512
const MAX_ACCOUNT_ID_LENGTH = 512

let cachedRegistry: RegistryFile | null = null

function getRegistryPath(): string {
  return join(getOrcaUserDataPath(), 'codex-session-accounts.json')
}

function emptyRegistry(): RegistryFile {
  return { version: 1, sessions: {} }
}

function normalizeKey(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null
}

function parseRegistry(value: unknown): RegistryFile {
  const parsed = emptyRegistry()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return parsed
  }
  const sessions = (value as Partial<RegistryFile>).sessions
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    return parsed
  }
  for (const [rawSessionId, rawRecord] of Object.entries(sessions)) {
    const sessionId = normalizeKey(rawSessionId, MAX_SESSION_ID_LENGTH)
    if (!sessionId || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      continue
    }
    const record = rawRecord as Partial<CodexSessionAccountRecord>
    const accountId =
      record.accountId === null ? null : normalizeKey(record.accountId, MAX_ACCOUNT_ID_LENGTH)
    if (accountId === null && record.accountId !== null) {
      continue
    }
    if (!Number.isFinite(record.observedAt) || (record.observedAt ?? -1) < 0) {
      continue
    }
    parsed.sessions[sessionId] = { accountId, observedAt: record.observedAt! }
  }
  return parsed
}

function readRegistry(): RegistryFile {
  if (cachedRegistry) {
    return cachedRegistry
  }
  try {
    cachedRegistry = parseRegistry(JSON.parse(readFileSync(getRegistryPath(), 'utf-8')))
  } catch {
    cachedRegistry = emptyRegistry()
  }
  return cachedRegistry
}

function writeRegistry(registry: RegistryFile): boolean {
  const registryPath = getRegistryPath()
  const temporaryPath = `${registryPath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(registryPath), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(registry)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    renameSync(temporaryPath, registryPath)
    return true
  } catch (error) {
    console.warn('[codex-session-accounts] Failed to persist session account registry:', error)
    try {
      rmSync(temporaryPath, { force: true })
    } catch {}
    return false
  }
}

/**
 * Snapshots the first authoritative account observed for a provider session.
 * A conflicting later launch cannot safely split historical token records, so
 * the original association wins instead of silently moving old usage.
 */
export function recordCodexSessionAccount(
  rawSessionId: string,
  accountId: string | null,
  observedAt = Date.now()
): boolean {
  const sessionId = normalizeKey(rawSessionId, MAX_SESSION_ID_LENGTH)
  const normalizedAccountId =
    accountId === null ? null : normalizeKey(accountId, MAX_ACCOUNT_ID_LENGTH)
  if (
    !sessionId ||
    (normalizedAccountId === null && accountId !== null) ||
    !Number.isFinite(observedAt) ||
    observedAt < 0
  ) {
    return false
  }
  const registry = readRegistry()
  const existing = registry.sessions[sessionId]
  if (existing) {
    return false
  }
  registry.sessions[sessionId] = { accountId: normalizedAccountId, observedAt }
  const sessionIds = Object.keys(registry.sessions)
  if (sessionIds.length > MAX_TRACKED_SESSIONS) {
    sessionIds
      .sort(
        (left, right) => registry.sessions[left]!.observedAt - registry.sessions[right]!.observedAt
      )
      .slice(0, sessionIds.length - MAX_TRACKED_SESSIONS)
      .forEach((staleSessionId) => delete registry.sessions[staleSessionId])
  }
  return writeRegistry(registry)
}

export function getCodexSessionAccountId(sessionId: string): string | null | undefined {
  return readRegistry().sessions[sessionId]?.accountId
}

/** Test seam: production state is process-lifetime cached. */
export function resetCodexSessionAccountRegistryForTests(): void {
  cachedRegistry = null
}
