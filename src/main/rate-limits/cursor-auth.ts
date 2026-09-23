import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Reads the session Cursor CLI writes, so Orca can query the dashboard for
 * usage. Orca never runs `cursor-agent login`; it only reads what the CLI
 * already stored, the same way the Grok provider reads ~/.grok/auth.json.
 */

/**
 * Where cursor-agent keeps its session.
 *
 * CURSOR_CONFIG_DIR comes first because the CLI honours it: a user who points
 * the CLI at another directory must not silently fall back to the stock path
 * and be shown a different account's usage.
 *
 * The default is the CLI's own `~/.config/cursor`, which it uses on macOS and
 * Linux alike rather than following each platform's app-data convention. On
 * Windows the CLI is normally run under WSL, where the same path resolves
 * inside the distro; a native Windows install without it finds no file and the
 * provider reports "not signed in", rather than this guessing at an `%APPDATA%`
 * layout it has not been verified against. CURSOR_CONFIG_DIR remains the escape
 * hatch for any install that keeps the session elsewhere.
 */
export function getCursorConfigDir(): string {
  const override = process.env.CURSOR_CONFIG_DIR?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.config', 'cursor')
}

export function getCursorAuthPath(): string {
  return join(getCursorConfigDir(), 'auth.json')
}

export function getCursorCliConfigPath(): string {
  return join(getCursorConfigDir(), 'cli-config.json')
}

export type CursorAuthSession = {
  /** WorkOS subject the dashboard keys usage by. */
  userId: string
  /** Cookie value the dashboard expects: `<userId>::<accessToken>`. */
  sessionToken: string
  email: string | null
}

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: CursorAuthSession }

function getCursorAuthReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Cursor auth file is invalid'
  }
  // Why: filesystem errors embed the full path; account state reaches the
  // renderer and mobile, which must not carry local usernames or a custom
  // CURSOR_CONFIG_DIR. Mirrors getGrokAuthReadError.
  return 'Unable to read Cursor auth file'
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/**
 * Reads the `sub` claim out of the access token.
 *
 * The dashboard keys usage by the WorkOS subject that issued the session, and
 * the token carries it. cli-config.json's `authInfo.userId` is Cursor's own
 * numeric account id — a different namespace — so it is only a fallback for
 * builds whose token omits the claim. Decodes public claims only; the
 * signature is never inspected or trusted, and a malformed token simply
 * yields null rather than throwing.
 */
function readSubjectClaim(accessToken: string): string | null {
  const payload = accessToken.split('.')[1]
  if (!payload) {
    return null
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    if (typeof claims !== 'object' || claims === null) {
      return null
    }
    const subject = (claims as { sub?: unknown }).sub
    if (typeof subject !== 'string' || subject.length === 0) {
      return null
    }
    // Cursor namespaces the subject as "auth0|user_01ABC…"; the dashboard
    // wants the bare id on the right of the separator.
    return subject.includes('|') ? (subject.split('|').pop() ?? null) : subject
  } catch {
    return null
  }
}

function readCliConfigAccount(): { userId: string | null; email: string | null } {
  const path = getCursorCliConfigPath()
  if (!existsSync(path)) {
    return { userId: null, email: null }
  }
  try {
    const parsed = readJsonFile(path)
    if (typeof parsed !== 'object' || parsed === null) {
      return { userId: null, email: null }
    }
    const authInfo = (parsed as { authInfo?: unknown }).authInfo
    if (typeof authInfo !== 'object' || authInfo === null) {
      return { userId: null, email: null }
    }
    const info = authInfo as { userId?: unknown; email?: unknown }
    // Why: current CLI builds write userId as a number, older ones as a string.
    const userId =
      typeof info.userId === 'number' || typeof info.userId === 'string'
        ? String(info.userId)
        : null
    return { userId, email: typeof info.email === 'string' ? info.email : null }
  } catch {
    // Why: cli-config.json only supplies a fallback id and the display email.
    // A corrupt one must not mask a perfectly good auth.json.
    return { userId: null, email: null }
  }
}

export function readCursorAuthSession(): CursorAuthReadResult {
  const authPath = getCursorAuthPath()
  if (!existsSync(authPath)) {
    return { status: 'missing' }
  }
  try {
    const parsed = readJsonFile(authPath)
    if (typeof parsed !== 'object' || parsed === null) {
      return { status: 'error', error: 'Cursor auth file is invalid' }
    }
    const accessToken = (parsed as { accessToken?: unknown }).accessToken
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      // Why: a token-less file (after `cursor-agent logout`) means signed out,
      // not a failure — 'error' would pin a status-bar alert for that user.
      return { status: 'missing' }
    }
    const account = readCliConfigAccount()
    const userId = readSubjectClaim(accessToken) ?? account.userId
    if (!userId) {
      return { status: 'error', error: 'Cursor auth file has no account id' }
    }
    return {
      status: 'ok',
      session: {
        userId,
        sessionToken: `${userId}::${accessToken}`,
        email: account.email
      }
    }
  } catch (err) {
    return { status: 'error', error: getCursorAuthReadError(err) }
  }
}
