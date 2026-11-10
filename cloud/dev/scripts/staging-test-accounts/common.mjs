// Shared helpers for the staging test-account scripts. Secrets live only in the accounts file
// (outside git, 0600) and in process memory; nothing here prints a password, token, or API key.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const AUTH_URL = 'https://auth-staging.onorca.dev'
export const PROPELAUTH_URL = 'https://327993609.propelauthtest.com'
export const GCP_PROJECT = 'onorca-cloud-staging'
export const DESKTOP_CLIENT_ID = 'orca-desktop'

export const ACCOUNTS_FILE =
  process.env.ORCA_STAGING_ACCOUNTS_FILE ??
  join(homedir(), '.orca-secrets', 'staging-test-accounts.env')

export const LABELS = ['OWNER', 'MEMBER']

export function readAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return {}
  return Object.fromEntries(
    readFileSync(ACCOUNTS_FILE, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1).trim()]
      })
  )
}

export function writeAccounts(values) {
  mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true, mode: 0o700 })
  const body = [
    '# Orca staging test accounts (auth-staging.onorca.dev, PropelAuth test env). Never commit.',
    ...Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`),
    ''
  ].join('\n')
  writeFileSync(ACCOUNTS_FILE, body, { mode: 0o600 })
  chmodSync(ACCOUNTS_FILE, 0o600)
}

export function account(label) {
  const values = readAccounts()
  const email = values[`STAGING_${label}_EMAIL`]
  const password = values[`STAGING_${label}_PASSWORD`]
  if (!email || !password) {
    throw new Error(`no ${label} account in ${ACCOUNTS_FILE}; run provision.mjs first`)
  }
  return { email, password }
}

// Optional local copy of the staging (test env) PropelAuth API key, for shells without gcloud.
export const API_KEY_FILE =
  process.env.ORCA_STAGING_PROPELAUTH_KEY_FILE ??
  join(homedir(), '.orca-secrets', 'staging-propelauth-api-key')

let apiKey
function propelAuthApiKey() {
  if (!PROPELAUTH_URL.endsWith('.propelauthtest.com')) {
    throw new Error('refusing: these scripts only talk to the PropelAuth test env')
  }
  if (!apiKey && existsSync(API_KEY_FILE)) {
    apiKey = readFileSync(API_KEY_FILE, 'utf8').trim()
  }
  // Otherwise read the staging secret each run, kept in memory only.
  apiKey ||= execFileSync(
    'gcloud',
    [
      'secrets',
      'versions',
      'access',
      'latest',
      '--secret=propelauth-api-key',
      `--project=${GCP_PROJECT}`
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
  return apiKey
}

/** PropelAuth backend API (staging test env). Returns { status, body }. */
export async function propelAuth(method, path, body) {
  const response = await fetch(new URL(path, `${PROPELAUTH_URL}/`), {
    method,
    headers: {
      authorization: `Bearer ${propelAuthApiKey()}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/** Orca auth desktop API with a session access token. Returns { status, body }. */
export async function orcaAuth(accessToken, method, path, body) {
  const response = await fetch(new URL(path, `${AUTH_URL}/`), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000)
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}
