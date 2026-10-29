// Environment tokens override keyring credentials and cannot be refreshed through gh auth refresh.
import { ghExecFileAsync } from '../git/runner'
import type { GhAuthDiagnostic, GhAuthAccount } from '../../shared/github/auth-types'

// ProjectV2 and surrounding repository/organization queries require these scopes.
const REQUIRED_SCOPES = ['project', 'read:org', 'repo'] as const

/** gh auth status has used both streams; accept either supplied diagnostic text. */
export function parseAuthStatus(text: string): GhAuthAccount[] {
  const accounts: GhAuthAccount[] = []
  let currentHost: string | null = null
  let current: GhAuthAccount | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    // Accept single-label Enterprise hosts and optional trailing colons.
    const hostMatch = line.match(/^([a-z0-9][a-z0-9.-]*(?::\d+)?)\s*:?\s*$/i)
    if (hostMatch && !/^logged\b/i.test(line)) {
      currentHost = hostMatch[1]
      continue
    }
    const loggedIn = line.match(/Logged in to (\S+) account (\S+)(?:\s+\(([^)]+)\))?/i)
    if (loggedIn) {
      if (current) {
        accounts.push(current)
      }
      // Inline host labels survive unfamiliar section-header formats.
      const host = loggedIn[1] || currentHost || 'github.com'
      const sourceLabel = (loggedIn[3] ?? '').trim()
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

export async function diagnoseGhAuth(
  requiredHost?: string,
  execOptions: { cwd?: string; wslDistro?: string } = {}
): Promise<GhAuthDiagnostic> {
  let raw = ''
  let ghAvailable = true
  try {
    // Capture diagnostics even on nonzero exit; use the repo runtime so inventory matches token resolution.
    const { stdout, stderr } = await ghExecFileAsync(['auth', 'status'], {
      ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}),
      ...(execOptions.wslDistro ? { wslDistro: execOptions.wslDistro } : {})
    })
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
      if (/ENOENT|not found|command not found/i.test(message)) {
        ghAvailable = false
      }
      raw = message
    }
  }
  const accounts = parseAuthStatus(raw)
  // Diagnose only the requested host's account; other hosts' scopes do not apply.
  const normalizedRequiredHost = requiredHost?.trim().toLowerCase() || null
  const hostAccounts = normalizedRequiredHost
    ? accounts.filter((a) => a.host.toLowerCase() === normalizedRequiredHost)
    : accounts
  const active =
    hostAccounts.find((a) => a.active) ??
    hostAccounts[0] ??
    (normalizedRequiredHost ? null : (accounts.find((a) => a.active) ?? accounts[0] ?? null))
  const envTokenInProcess: 'GITHUB_TOKEN' | 'GH_TOKEN' | null = process.env.GH_TOKEN
    ? 'GH_TOKEN'
    : process.env.GITHUB_TOKEN
      ? 'GITHUB_TOKEN'
      : null
  const missingScopes = active
    ? REQUIRED_SCOPES.filter((s) => !active.scopes.includes(s))
    : [...REQUIRED_SCOPES]
  // Unsetting an environment token helps only when keyring credentials exist for the same host.
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
    hasKeyringFallback: Boolean(keyringFallback && keyringFallback !== active),
    requiredHost: normalizedRequiredHost,
    requiredHostAuthenticated: normalizedRequiredHost ? hostAccounts.length > 0 : null
  }
}
