/**
 * gh CLI auth diagnostics.
 *
 * Why: when project queries fail with "missing scope", the canned
 * remediation `gh auth refresh -s project ...` silently no-ops if the user
 * has `GITHUB_TOKEN` (or `GH_TOKEN`) exported in their shell — gh prefers
 * env tokens over keyring credentials and refuses to refresh env-supplied
 * tokens. Users follow the instructions, see no error, retry, and stay
 * stuck. This probe makes that failure mode legible in the UI.
 *
 * Output is parsed from `gh auth status`, which prints free-form text but
 * uses stable field labels ("Token scopes:", "(GITHUB_TOKEN)", etc.).
 */
import { ghExecFileAsync } from '../git/runner'
import type { GhAuthDiagnostic, GhAuthAccount } from '../../shared/github-auth-types'

// Required scopes for ProjectV2 GraphQL access in Orca. `project` is the
// scope that gates ProjectV2 reads/writes; the others are needed for the
// surrounding repo/org queries we already run.
const REQUIRED_SCOPES = ['project', 'read:org', 'repo'] as const

/**
 * Parse `gh auth status` stderr/stdout. gh writes to stderr by default but
 * has used stdout in some versions; we accept either. Format (per host):
 *
 *   github.com
 *     ✓ Logged in to github.com account NAME (GITHUB_TOKEN)
 *     - Active account: true
 *     - Token scopes: 'gist', 'read:org', 'repo'
 */
export function parseAuthStatus(text: string): GhAuthAccount[] {
  const accounts: GhAuthAccount[] = []
  let currentHost: string | null = null
  let current: GhAuthAccount | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    // Host header: a non-indented hostname token, with an optional
    // trailing colon some gh versions emit. Permits single-label hostnames
    // (internal GHES like `github` or `ghe-internal`); we also recover the
    // host from the `Logged in to <host>` line below if this header was
    // missed, so a parser miss never silently drops every account.
    const hostMatch = line.match(/^([a-z0-9][a-z0-9.-]*)\s*:?\s*$/i)
    if (hostMatch && !/^logged\b/i.test(line)) {
      currentHost = hostMatch[1]
      continue
    }
    const loggedIn = line.match(/Logged in to (\S+) account (\S+)(?:\s+\(([^)]+)\))?/i)
    if (loggedIn) {
      if (current) {
        accounts.push(current)
      }
      // Prefer the host from the `Logged in to <host>` line itself — it's
      // always present, whereas the section header above can be skipped
      // by the regex on unfamiliar gh output.
      const host = loggedIn[1] || currentHost || 'github.com'
      const sourceLabel = (loggedIn[3] ?? '').trim()
      // gh emits "(keyring)" for stored creds and "(GITHUB_TOKEN)" /
      // "(GH_TOKEN)" when an env var is shadowing the keyring.
      const envToken =
        sourceLabel === 'GITHUB_TOKEN' || sourceLabel === 'GH_TOKEN' ? sourceLabel : null
      current = {
        host,
        user: loggedIn[2],
        active: false,
        envToken,
        source: envToken ? 'env' : 'keyring',
        scopes: []
      }
      continue
    }
    if (!current) {
      continue
    }
    const activeMatch = line.match(/Active account:\s*(true|false)/i)
    if (activeMatch) {
      current.active = activeMatch[1].toLowerCase() === 'true'
      continue
    }
    const scopesMatch = line.match(/Token scopes:\s*(.+)$/i)
    if (scopesMatch) {
      current.scopes = scopesMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    }
  }
  if (current) {
    accounts.push(current)
  }
  return accounts
}

export async function diagnoseGhAuth(): Promise<GhAuthDiagnostic> {
  let raw = ''
  let ghAvailable = true
  try {
    // `gh auth status` exits non-zero when no host is logged in but still
    // prints the same diagnostic text we want, so capture both streams.
    const { stdout, stderr } = await ghExecFileAsync(['auth', 'status'])
    raw = `${stdout}\n${stderr}`
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : ''
    const stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout?: unknown }).stdout ?? '')
        : ''
    raw = `${stdout}\n${stderr}`
    if (!raw.trim()) {
      const message = err instanceof Error ? err.message : String(err)
      // Most likely cause: gh CLI not installed or not on PATH.
      if (/ENOENT|not found|command not found/i.test(message)) {
        ghAvailable = false
      }
      raw = message
    }
  }
  const accounts = parseAuthStatus(raw)
  const active = accounts.find((a) => a.active) ?? accounts[0] ?? null
  const envTokenInProcess: 'GITHUB_TOKEN' | 'GH_TOKEN' | null = process.env.GH_TOKEN
    ? 'GH_TOKEN'
    : process.env.GITHUB_TOKEN
      ? 'GITHUB_TOKEN'
      : null
  const missingScopes = active
    ? REQUIRED_SCOPES.filter((s) => !active.scopes.includes(s))
    : [...REQUIRED_SCOPES]
  // Is there a non-env (keyring) account we could fall back to by unsetting
  // the env var? Only meaningful if the active account is env-shadowed, and
  // only if the keyring login is on the SAME host — otherwise unsetting the
  // env var leaves the user with no credential for the host that was active.
  const keyringFallback = active
    ? (accounts.find((a) => a.source === 'keyring' && a.host === active.host) ?? null)
    : null
  return {
    ghAvailable,
    activeAccount: active,
    accounts,
    envTokenInProcess,
    missingScopes,
    requiredScopes: [...REQUIRED_SCOPES],
    hasKeyringFallback: Boolean(keyringFallback && keyringFallback !== active)
  }
}
