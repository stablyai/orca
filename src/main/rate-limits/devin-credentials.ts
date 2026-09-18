import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDevinCliDataDir } from '../devin/devin-cli-data-dir'

// Why: the Devin CLI stores credentials.toml next to its cli data dir
// (%APPDATA%\devin\credentials.toml vs %APPDATA%\devin\cli on Windows;
// $XDG_DATA_HOME/devin/credentials.toml on posix).
export function getDevinCredentialsPath(): string {
  return join(dirname(resolveDevinCliDataDir()), 'credentials.toml')
}

export type DevinCredentials = {
  sessionToken: string
  /** Connect-RPC host the CLI calls (api_server_url); defaults to server.codeium.com. */
  apiServerUrl: string
}

export type DevinCredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: DevinCredentials }

const DEFAULT_DEVIN_API_SERVER = 'https://server.codeium.com'
const DEVIN_SESSION_TOKEN_PREFIX = 'devin-session-token$'

function getDevinCredentialsReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Devin credentials file is invalid'
  }
  // Why: filesystem errors include the full path; renderer/mobile surfaces
  // should not expose local usernames or a custom DEVIN_HOME.
  return 'Unable to read Devin credentials file'
}

// credentials.toml is a flat `key = "value"` file written by the Devin CLI; a
// line parser avoids pulling a TOML dependency for two fields.
function parseCredentialsToml(raw: string): DevinCredentials | null {
  let sessionToken: string | null = null
  let apiServerUrl: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"(.*)"\s*$/)
    if (!match) {
      continue
    }
    if (match[1] === 'windsurf_api_key' && match[2].length > 0) {
      sessionToken = match[2]
    } else if (match[1] === 'api_server_url' && match[2].length > 0) {
      apiServerUrl = match[2]
    }
  }
  if (!sessionToken) {
    return null
  }
  return {
    sessionToken: sessionToken.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
      ? sessionToken
      : `${DEVIN_SESSION_TOKEN_PREFIX}${sessionToken}`,
    apiServerUrl: (apiServerUrl ?? DEFAULT_DEVIN_API_SERVER).replace(/\/+$/, '')
  }
}

export function readDevinCredentials(): DevinCredentialsReadResult {
  const path = getDevinCredentialsPath()
  if (!existsSync(path)) {
    return { status: 'missing' }
  }
  try {
    const credentials = parseCredentialsToml(readFileSync(path, 'utf-8'))
    // Why: a token-less file means signed out, not a failure — 'error' would
    // keep a status-bar alert visible for a user who simply logged out.
    return credentials ? { status: 'ok', credentials } : { status: 'missing' }
  } catch (err) {
    return { status: 'error', error: getDevinCredentialsReadError(err) }
  }
}
