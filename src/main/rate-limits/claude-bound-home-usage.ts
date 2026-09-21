import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BoundClaudeHomeStatus, ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeCredentialsFromStrictKeychain,
  readClaudeOAuthCredentialsFile,
  type ClaudeOAuthCredentialReadResult
} from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'

export type BoundClaudeHomeUsageResult = {
  status: BoundClaudeHomeStatus
  rateLimits: ProviderRateLimits | null
}

type BoundClaudeHomeCredentials =
  | { kind: 'token'; token: string }
  | { kind: 'status'; status: Exclude<BoundClaudeHomeStatus, 'ok'> }

function unavailable(
  status: Exclude<BoundClaudeHomeStatus, 'ok'>
): BoundClaudeHomeUsageResult & { status: Exclude<BoundClaudeHomeStatus, 'ok'> } {
  return { status, rateLimits: null }
}

/**
 * Why re-read the file instead of trusting the resolver's empty result: it collapses "never signed
 * in", "malformed" and "unreachable" into one shape, and the switcher shows the user a different
 * line for each. Only reached when no source produced a token.
 */
async function classifyTokenlessBoundHome(
  configDir: string
): Promise<Exclude<BoundClaudeHomeStatus, 'ok'>> {
  try {
    JSON.parse(await readFile(path.join(configDir, '.credentials.json'), 'utf-8'))
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
    // A directory nobody has signed into reads as signed-out; a permissions error, a dead mount or
    // malformed JSON is a state Orca cannot judge.
    return code === 'ENOENT' ? 'signed-out' : 'unreadable'
  }
  return 'signed-out'
}

/**
 * Deliberately not `readClaudeOAuthCredentials`: for a *bound* directory its legacy step would let
 * the unscoped `Claude Code-credentials` item — the user's own `~/.claude` token — answer for a
 * directory that was never signed into, rendering one identity's quota under another's name.
 * Scoped item then file, on every platform, parsing the payload rather than testing for existence.
 */
async function readBoundClaudeHomeCredentials(
  configDir: string,
  now: number
): Promise<BoundClaudeHomeCredentials> {
  const scoped = await readClaudeCredentialsFromStrictKeychain(configDir, 'scoped-keychain')
  const fromFile: ClaudeOAuthCredentialReadResult | null = scoped.token
    ? null
    : await readClaudeOAuthCredentialsFile(configDir)
  const credentials = fromFile ?? scoped
  const token = credentials.token?.trim() ?? ''
  if (!token) {
    // Why: a Keychain Orca could not reach is not evidence that the directory is signed out.
    if (scoped.keychainUnavailable) {
      return { kind: 'status', status: 'unreadable' }
    }
    // Why not signed-out: a directory left holding only a refresh token is one `claude` run away
    // from working. "Signed out" sends the user to a full re-login, which is the operation most
    // likely to rotate the token Orca is deliberately not touching. Either source counts, because
    // an access token in neither does not mean a refresh token in neither.
    if (scoped.hasRefreshableCredentials || fromFile?.hasRefreshableCredentials) {
      return { kind: 'status', status: 'expired' }
    }
    return { kind: 'status', status: await classifyTokenlessBoundHome(configDir) }
  }
  // Why act on expiresAt here alone: callers that may refresh let the server decide, but Orca never
  // refreshes a bound directory (D9), so a lapsed token is a status the user can act on.
  const { expiresAt } = credentials
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now) {
    return { kind: 'status', status: 'expired' }
  }
  return { kind: 'token', token }
}

/**
 * HTTP-only usage for one bound CLAUDE_CONFIG_DIR (D10). Reads the directory's credentials and,
 * only when they hold a live access token, makes exactly one OAuth usage call. Nothing on this
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
