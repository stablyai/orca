import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Why: Hermes stores the Nous Portal OAuth session in ~/.hermes/auth.json
// (HERMES_HOME overrides the root, mirroring hermes_cli/auth.py). Orca is
// read-only here — the Hermes CLI owns the login lifecycle.
export function getHermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()
  return override ? override : join(homedir(), '.hermes')
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
    const providerState = (parsed as Record<string, unknown>).providers?.['nous']
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
    return {
      status: 'ok',
      session: {
        accessToken,
        refreshToken: asOptionalString(state.refresh_token),
        clientId: asOptionalString(state.client_id) ?? DEFAULT_NOUS_CLIENT_ID,
        portalBaseUrl: asOptionalString(state.portal_base_url) ?? DEFAULT_NOUS_PORTAL_BASE_URL,
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
