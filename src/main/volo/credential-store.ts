import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { VoloViewer } from '../../shared/volo-types'
import {
  parseStoredVoloSecret,
  parseVoloGoogleSession,
  type VoloGoogleSession
} from '../../shared/volo-google-session'

export type VoloConnectionFile = {
  version: 1
  apiUrl: string
  webUrl: string
  viewer: VoloViewer
}

let cachedConnection: VoloConnectionFile | null = null
let connectionLoaded = false
let cachedSession: VoloGoogleSession | null = null
let sessionLoaded = false
export let credentialError: string | undefined

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getConnectionFilePath(): string {
  return join(getOrcaDir(), 'volo-connection.json')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'volo-token.enc')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function getSavedLocalCredentialsPath(): string {
  return join(homedir(), '.jaak-volo', 'credentials.json')
}

export function readSavedLocalGoogleSession(): VoloGoogleSession | null {
  try {
    const parsed = JSON.parse(
      readFileSync(getSavedLocalCredentialsPath(), { encoding: 'utf-8' })
    ) as unknown
    return parseVoloGoogleSession(parsed)
  } catch {
    return null
  }
}

export function writeSavedLocalGoogleSession(session: VoloGoogleSession): void {
  const dir = join(homedir(), '.jaak-volo')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(
    getSavedLocalCredentialsPath(),
    JSON.stringify(
      {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
        expiresAt: session.expiresAt,
        userId: session.userId,
        email: session.email,
        name: session.name
      },
      null,
      2
    ),
    { encoding: 'utf-8', mode: 0o600 }
  )
}

export function hasSavedLocalCredentials(): boolean {
  const session = readSavedLocalGoogleSession()
  return Boolean(session?.accessToken || session?.refreshToken)
}

export function readSession(): VoloGoogleSession | null {
  if (sessionLoaded) {
    return cachedSession
  }
  sessionLoaded = true
  cachedSession = readOrcaEncryptedSession()
  return cachedSession
}

function readOrcaEncryptedSession(): VoloGoogleSession | null {
  const path = getTokenPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readStoredCredentialToken('Volo', readFileSync(path))
    credentialError = undefined
    return raw ? parseStoredVoloSecret(raw) : null
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
      throw error
    }
    return null
  }
}

export function persistGoogleSession(session: VoloGoogleSession): void {
  ensureOrcaDir()
  writeEncryptedCredential('Volo', getTokenPath(), JSON.stringify(session))
  cachedSession = session
  sessionLoaded = true
  credentialError = undefined
  if (session.refreshToken) {
    writeSavedLocalGoogleSession(session)
  }
}

function normalizeViewer(input: unknown): VoloViewer | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.displayName !== 'string') {
    return null
  }
  return {
    id: record.id,
    displayName: record.displayName,
    email: typeof record.email === 'string' ? record.email : null,
    ...(typeof record.avatarUrl === 'string' ? { avatarUrl: record.avatarUrl } : {})
  }
}

function normalizeConnection(input: unknown): VoloConnectionFile | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  const viewer = normalizeViewer(record.viewer)
  if (
    record.version !== 1 ||
    typeof record.apiUrl !== 'string' ||
    typeof record.webUrl !== 'string' ||
    !viewer
  ) {
    return null
  }
  return {
    version: 1,
    apiUrl: record.apiUrl,
    webUrl: record.webUrl,
    viewer
  }
}

export function readConnection(): VoloConnectionFile | null {
  if (connectionLoaded) {
    return cachedConnection
  }
  connectionLoaded = true
  try {
    if (!existsSync(getConnectionFilePath())) {
      cachedConnection = null
      return null
    }
    cachedConnection = normalizeConnection(
      JSON.parse(readFileSync(getConnectionFilePath(), { encoding: 'utf-8' }))
    )
    return cachedConnection
  } catch {
    cachedConnection = null
    return null
  }
}

export function writeConnection(file: VoloConnectionFile): void {
  ensureOrcaDir()
  cachedConnection = file
  connectionLoaded = true
  writeFileSync(getConnectionFilePath(), JSON.stringify(file, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

export function readToken(): string | null {
  return readSession()?.accessToken ?? null
}

export function saveToken(apiToken: string): void {
  const current = readSession()
  persistGoogleSession({
    accessToken: apiToken,
    refreshToken: current?.refreshToken ?? '',
    expiresAt: current?.expiresAt ?? 0,
    userId: current?.userId ?? '',
    email: current?.email ?? '',
    name: current?.name ?? ''
  })
}

export function clearConnection(): void {
  cachedConnection = null
  connectionLoaded = true
  cachedSession = null
  sessionLoaded = true
  credentialError = undefined
  try {
    unlinkSync(getConnectionFilePath())
  } catch {
    // Connection file may not exist.
  }
  try {
    unlinkSync(getTokenPath())
  } catch {
    // Token file may not exist.
  }
}

export function hasStoredToken(): boolean {
  return cachedSession !== null || existsSync(getTokenPath())
}
