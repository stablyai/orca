import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The Muse CLI's auth file: `$XDG_CONFIG_HOME/muse/auth.json`, default `~/.config/muse/auth.json`. */
export function getMuseAuthPath(): string {
  const executionHome = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(executionHome || homedir(), '.config')
  return join(configHome, 'muse', 'auth.json')
}

// Why: only the display metadata is kept. Token presence decides signed-in, but the
// access_token/api_key values themselves are never retained or returned: nothing in
// Orca calls the Meta API with them.
export type MuseAuthSession = {
  hasCredential: boolean
  email: string | null
  fullName: string | null
  subscriptionActive: boolean | null
  obtainedVia: string | null
}

export type MuseAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: MuseAuthSession }

function getMuseAuthReadError(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Muse auth file is invalid'
  }
  // Why: filesystem errors often include the full auth path; account state
  // should not expose local usernames or custom XDG_CONFIG_HOME values.
  return 'Unable to read Muse auth file'
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sessionFromMetaEntry(entry: Record<string, unknown>): MuseAuthSession | null {
  const hasCredential =
    optionalString(entry.access_token) !== null || optionalString(entry.api_key) !== null
  if (!hasCredential) {
    return null
  }
  return {
    hasCredential: true,
    email: optionalString(entry.user_email),
    fullName: optionalString(entry.user_full_name),
    subscriptionActive: typeof entry.subs_active === 'boolean' ? entry.subs_active : null,
    obtainedVia: optionalString(entry.obtained_via)
  }
}

export function readMuseAuthSession(authPath = getMuseAuthPath()): MuseAuthReadResult {
  if (!existsSync(authPath)) {
    return { status: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return { status: 'error', error: 'Muse auth file is invalid' }
    }
    const providers = (parsed as { providers?: unknown }).providers
    if (typeof providers !== 'object' || providers === null) {
      return { status: 'error', error: 'Muse auth file is invalid' }
    }
    // Why: `muse auth set --provider` only accepts `meta`, so it is the one entry read.
    const meta = (providers as Record<string, unknown>).meta
    if (typeof meta !== 'object' || meta === null) {
      // Why: a file with no meta entry (e.g. after `muse logout`) means signed
      // out, not a failure — 'error' would keep an alert visible for that user.
      return { status: 'missing' }
    }
    const session = sessionFromMetaEntry(meta as Record<string, unknown>)
    // Why: a token-less entry means signed out, not a failure (same as above).
    return session ? { status: 'ok', session } : { status: 'missing' }
  } catch (err) {
    return {
      status: 'error',
      error: getMuseAuthReadError(err)
    }
  }
}
