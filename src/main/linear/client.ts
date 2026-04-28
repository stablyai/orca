import { safeStorage } from 'electron'
import { LinearClient, AuthenticationLinearError } from '@linear/sdk'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { LinearViewer, LinearConnectionStatus } from '../../shared/types'

// ── Concurrency limiter — max 4 parallel Linear API calls ────────────
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++
      resolve()
    })
  )
}

export function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next()
  }
}

// ── Token + viewer storage ───────────────────────────────────────────
// Why: the token is encrypted via safeStorage (OS keychain). The viewer
// metadata is kept in a separate *plaintext* file so settings/status
// checks can answer "are you connected, and as whom?" without ever
// decrypting the token. Decrypting triggers a macOS Keychain permission
// dialog after every app signature change (e.g. every update), so we only
// touch the encrypted token when the user actually makes a Linear API
// call or explicitly tests the connection.
function getTokenPath(): string {
  return join(homedir(), '.orca', 'linear-token.enc')
}

function getViewerPath(): string {
  return join(homedir(), '.orca', 'linear-viewer.json')
}

let cachedToken: string | null = null
let cachedViewer: LinearViewer | null = null
let viewerLoadedFromDisk = false

function readViewerFromDisk(): LinearViewer | null {
  const path = getViewerPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearViewer>
    if (typeof parsed?.displayName !== 'string' || typeof parsed?.organizationName !== 'string') {
      return null
    }
    return {
      displayName: parsed.displayName,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      organizationName: parsed.organizationName
    }
  } catch {
    return null
  }
}

function writeViewerToDisk(viewer: LinearViewer): void {
  const dir = join(homedir(), '.orca')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getViewerPath(), JSON.stringify(viewer), { encoding: 'utf-8', mode: 0o600 })
}

function clearViewerOnDisk(): void {
  try {
    unlinkSync(getViewerPath())
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function saveToken(apiKey: string): void {
  const dir = join(homedir(), '.orca')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tokenPath = getTokenPath()
  // Why: safeStorage uses the OS keychain (macOS Keychain, Windows DPAPI,
  // Linux libsecret) to encrypt. If the keychain is unavailable (e.g. headless
  // Linux without a keyring), fall back to plaintext with a warning — the user
  // explicitly chose to store a personal API key on this machine.
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiKey)
    writeFileSync(tokenPath, encrypted, { mode: 0o600 })
  } else {
    console.warn('[linear] safeStorage encryption unavailable — storing token in plaintext')
    writeFileSync(tokenPath, apiKey, { encoding: 'utf-8', mode: 0o600 })
  }
  cachedToken = apiKey
}

// Why: force=true is used when the caller wants a token and accepts the
// keychain prompt (explicit "Test connection" or an actual API call). The
// default call path is fine with returning null if we haven't decrypted yet
// this session, so status checks don't trigger Keychain.
export function loadToken(options: { force?: boolean } = {}): string | null {
  if (cachedToken !== null) {
    return cachedToken
  }
  if (!options.force) {
    return null
  }
  const tokenPath = getTokenPath()
  if (!existsSync(tokenPath)) {
    return null
  }
  try {
    const raw = readFileSync(tokenPath)
    cachedToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8')
    return cachedToken
  } catch {
    return null
  }
}

export function hasStoredToken(): boolean {
  if (cachedToken !== null) {
    return true
  }
  return existsSync(getTokenPath())
}

export function clearToken(): void {
  cachedToken = null
  cachedViewer = null
  viewerLoadedFromDisk = false
  const tokenPath = getTokenPath()
  try {
    unlinkSync(tokenPath)
  } catch {
    // File may not exist — safe to ignore.
  }
  clearViewerOnDisk()
}

// ── Client factory ───────────────────────────────────────────────────
// Why: this is called by the issues/teams modules when the user actually
// performs a Linear action — at that point decrypting the token (and
// surfacing a Keychain prompt if needed) is expected.
export function getClient(): LinearClient | null {
  const token = loadToken({ force: true })
  if (!token) {
    return null
  }
  return new LinearClient({ apiKey: token })
}

// ── Auth error detection ─────────────────────────────────────────────
// Why: 401 errors must trigger token clearing and a re-auth prompt in the
// renderer (design §Error Propagation). All other errors are swallowed
// with console.warn to match GitHub client's graceful degradation.
export function isAuthError(error: unknown): boolean {
  return error instanceof AuthenticationLinearError
}

// ── Connect / disconnect / status ────────────────────────────────────
export async function connect(
  apiKey: string
): Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }> {
  try {
    const client = new LinearClient({ apiKey })
    const me = await client.viewer
    const org = await me.organization

    const viewer: LinearViewer = {
      displayName: me.displayName,
      email: me.email ?? null,
      organizationName: org.name
    }

    saveToken(apiKey)
    writeViewerToDisk(viewer)
    cachedViewer = viewer
    viewerLoadedFromDisk = true
    return { ok: true, viewer }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate API key'
    return { ok: false, error: message }
  }
}

export function disconnect(): void {
  clearToken()
}

// Why: getStatus must NEVER decrypt the token. It returns the cached
// viewer (written at connect time) so the settings/landing UIs can show
// "Connected as X" without triggering a Keychain permission dialog after
// every app update. The encrypted token is only touched lazily on real
// Linear API calls or when the user clicks "Test connection".
export function getStatus(): LinearConnectionStatus {
  if (!hasStoredToken()) {
    return { connected: false, viewer: null }
  }

  if (!cachedViewer && !viewerLoadedFromDisk) {
    cachedViewer = readViewerFromDisk()
    viewerLoadedFromDisk = true
  }

  return { connected: true, viewer: cachedViewer }
}

// Why: explicit user-initiated check. Decrypts the token, pings the
// Linear API to re-validate, and refreshes the cached viewer file. If the
// token is rejected (401) it clears state just like a live API error.
export async function testConnection(): Promise<
  { ok: true; viewer: LinearViewer } | { ok: false; error: string }
> {
  const token = loadToken({ force: true })
  if (!token) {
    return { ok: false, error: 'No API key stored.' }
  }
  try {
    const client = new LinearClient({ apiKey: token })
    const me = await client.viewer
    const org = await me.organization
    const viewer: LinearViewer = {
      displayName: me.displayName,
      email: me.email ?? null,
      organizationName: org.name
    }
    writeViewerToDisk(viewer)
    cachedViewer = viewer
    viewerLoadedFromDisk = true
    return { ok: true, viewer }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
    }
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
}

// Why: called at main-process startup. This used to eagerly decrypt the
// token (which triggered a Keychain prompt on every launch after an app
// update). We now only warm the plaintext viewer cache — the token stays
// encrypted on disk until actually needed.
export function initLinearToken(): void {
  if (!viewerLoadedFromDisk) {
    cachedViewer = readViewerFromDisk()
    viewerLoadedFromDisk = true
  }
}
