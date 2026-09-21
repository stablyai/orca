import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BoundClaudeHomeStatus, ProviderRateLimits } from '../../shared/rate-limit-types'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'

export type BoundClaudeHomeUsageResult = {
  status: BoundClaudeHomeStatus
  rateLimits: ProviderRateLimits | null
}

type BoundClaudeHomeCredentials =
  | { kind: 'token'; token: string }
  | { kind: 'status'; status: Exclude<BoundClaudeHomeStatus, 'ok'> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unavailable(
  status: Exclude<BoundClaudeHomeStatus, 'ok'>
): BoundClaudeHomeUsageResult & { status: Exclude<BoundClaudeHomeStatus, 'ok'> } {
  return { status, rateLimits: null }
}

/**
 * Deliberately not `parseClaudeOAuthCredentialsJson`: that one ignores `expiresAt` and lets the
 * server decide, because its callers may refresh. Orca never refreshes a bound directory (D9), so
 * here a lapsed token is a status the user can act on, not a request worth sending.
 */
function parseBoundClaudeHomeCredentials(raw: string, now: number): BoundClaudeHomeCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'status', status: 'unreadable' }
  }
  const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined
  const accessToken = isRecord(oauth) ? oauth.accessToken : undefined
  const token = typeof accessToken === 'string' ? accessToken.trim() : ''
  if (!token) {
    return { kind: 'status', status: 'signed-out' }
  }
  const expiresAt = isRecord(oauth) ? oauth.expiresAt : undefined
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now) {
    return { kind: 'status', status: 'expired' }
  }
  return { kind: 'token', token }
}

async function readBoundClaudeHomeCredentials(
  configDir: string,
  now: number
): Promise<BoundClaudeHomeCredentials> {
  let raw: string
  try {
    raw = await readFile(path.join(configDir, '.credentials.json'), 'utf-8')
  } catch (error) {
    // A directory the user has simply not signed into yet reads as signed-out; anything else
    // (permissions, a directory in place of the file, a dead mount) is a state Orca cannot judge.
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
    return { kind: 'status', status: code === 'ENOENT' ? 'signed-out' : 'unreadable' }
  }
  return parseBoundClaudeHomeCredentials(raw, now)
}

/**
 * HTTP-only usage for one bound CLAUDE_CONFIG_DIR (D10). Reads the directory's credentials file
 * and, only when it holds a live access token, makes exactly one OAuth usage call. Nothing on this
 * path writes: no credential staging, no PTY, no Keychain item, no token refresh.
 */
export async function fetchBoundClaudeHomeUsage(
  configDir: string,
  options: { signal?: AbortSignal } = {}
): Promise<BoundClaudeHomeUsageResult> {
  const credentials = await readBoundClaudeHomeCredentials(configDir, Date.now())
  if (credentials.kind === 'status') {
    return unavailable(credentials.status)
  }
  return {
    status: 'ok',
    rateLimits: await fetchClaudeOAuthUsage(credentials.token, options.signal)
  }
}
