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

// ── Token storage ────────────────────────────────────────────────────
function getTokenPath(): string {
  return join(homedir(), '.orca', 'linear-token.enc')
}

let cachedToken: string | null = null
let cachedViewer: LinearViewer | null = null

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

export function loadToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken
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

export function clearToken(): void {
  cachedToken = null
  cachedViewer = null
  const tokenPath = getTokenPath()
  try {
    unlinkSync(tokenPath)
  } catch {
    // File may not exist — safe to ignore.
  }
}

// ── Client factory ───────────────────────────────────────────────────
export function getClient(): LinearClient | null {
  const token = loadToken()
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
    cachedViewer = viewer
    return { ok: true, viewer }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate API key'
    return { ok: false, error: message }
  }
}

export function disconnect(): void {
  clearToken()
}

export async function getStatus(): Promise<LinearConnectionStatus> {
  const token = loadToken()
  if (!token) {
    return { connected: false, viewer: null }
  }

  if (cachedViewer) {
    return { connected: true, viewer: cachedViewer }
  }

  // Lazily fetch viewer info on first status check after app restart.
  try {
    const client = new LinearClient({ apiKey: token })
    const me = await client.viewer
    const org = await me.organization

    cachedViewer = {
      displayName: me.displayName,
      email: me.email ?? null,
      organizationName: org.name
    }
    return { connected: true, viewer: cachedViewer }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
    }
    return { connected: false, viewer: null }
  }
}

export function initLinearToken(): void {
  loadToken()
}
