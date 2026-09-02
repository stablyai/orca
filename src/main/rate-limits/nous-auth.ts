import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveDefaultHermesHome } from '../skills/skill-provider-runtime-roots'

// Why: Hermes stores the Nous Portal OAuth session in ~/.hermes/auth.json
// (HERMES_HOME overrides the root, mirroring hermes_cli/auth.py). Orca is
// read-only here — the Hermes CLI owns the login lifecycle. The unset-HERMES_HOME
// default is shared with the skill provider so Windows installs resolve to
// %LOCALAPPDATA%\hermes instead of a dotfolder that never exists there.
export function getHermesHome(input?: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  directoryExists?: (candidate: string) => boolean
}): string {
  const env = input?.env ?? process.env
  const override = env.HERMES_HOME?.trim()
  if (override) {
    return override
  }
  return resolveDefaultHermesHome({
    homeDir: input?.homeDir ?? homedir(),
    env,
    platform: input?.platform,
    directoryExists: input?.directoryExists
  })
}

export function getNousAuthPath(): string {
  return join(getHermesHome(), 'auth.json')
}

export type NousAuthSession = {
  accessToken: string
  refreshToken: string | null
  clientId: string
  portalBaseUrl: string
  /** Unix ms timestamp when the access token expires, if known. */
  expiresAtMs: number | null
}

export type NousAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: NousAuthSession }

export const DEFAULT_NOUS_PORTAL_BASE_URL = 'https://portal.nousresearch.com'
export const DEFAULT_NOUS_CLIENT_ID = 'hermes-cli'

// Why: portal_base_url arrives from the local auth file, so it must be treated
// as untrusted — a tampered file must never redirect OAuth credentials to an
// arbitrary host. Only the canonical https origin (no userinfo, port, or path)
// is acceptable; anything else fails closed (the fetcher never fetches).
export function isTrustedNousPortalBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'portal.nousresearch.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '' || url.pathname === '/')
    )
  } catch {
    return false
  }
}

function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Why: the profile-local auth.json is the source of truth; the shared store
// (~/.hermes/shared/nous_auth.json) is a cross-profile convenience copy that
// Hermes merges over the local state when its refresh token differs, so a
// refresh must update both (see nous-fetcher persistNousRefresh).
export function getNousSharedStorePath(): string {
  return join(getHermesHome(), 'shared', 'nous_auth.json')
}

export function readNousAuthSession(): NousAuthReadResult {
  const path = getNousAuthPath()
  if (!existsSync(path)) {
    return { status: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return { status: 'error', error: 'Hermes auth file is invalid' }
    }
    const providers = (parsed as Record<string, unknown>).providers
    const providerState =
      typeof providers === 'object' && providers !== null
        ? (providers as Record<string, unknown>)['nous']
        : undefined
    if (typeof providerState !== 'object' || providerState === null) {
      return { status: 'missing' }
    }
    const accessToken = asOptionalString((providerState as Record<string, unknown>).access_token)
    // Why: a token-less nous block (after `hermes portal logout`) means signed
    // out, not a failure — 'error' would keep a status-bar alert visible.
    if (!accessToken) {
      return { status: 'missing' }
    }
    const state = providerState as Record<string, unknown>
    const portalBaseUrl =
      asOptionalString(state.portal_base_url) ?? DEFAULT_NOUS_PORTAL_BASE_URL
    // Why: fail closed on a tampered portal_base_url so the credentialed
    // requests below can never be redirected to an arbitrary host.
    if (!isTrustedNousPortalBaseUrl(portalBaseUrl)) {
      return { status: 'error', error: 'Hermes auth file has an untrusted portal URL' }
    }
    return {
      status: 'ok',
      session: {
        accessToken,
        refreshToken: asOptionalString(state.refresh_token),
        clientId: asOptionalString(state.client_id) ?? DEFAULT_NOUS_CLIENT_ID,
        portalBaseUrl,
        expiresAtMs: parseExpiresAtMs(state.expires_at)
      }
    }
  } catch (error) {
    return {
      status: 'error',
      error:
        error instanceof SyntaxError
          ? 'Hermes auth file is invalid'
          : 'Unable to read Hermes auth file'
    }
  }
}
