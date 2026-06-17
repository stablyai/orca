import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { safeStorage } from 'electron'

import type { TrelloViewer } from '../../shared/trello-types'

type StoredTrelloCredentials = {
  version: 1
  apiKey: string
  tokenEncrypted?: string
  token?: string
  viewer: TrelloViewer | null
}

export type TrelloCredentialsMetadata = {
  apiKey: string
  viewer: TrelloViewer | null
  hasToken: boolean
}

let cachedMetadata: TrelloCredentialsMetadata | null = null
let metadataLoaded = false
let cachedToken: string | null = null

let testBaseDir: string | undefined

/** @internal Test-only seam — never called in production. */
export function __setTestBaseDir(dir: string | undefined): void {
  testBaseDir = dir
  cachedToken = null
  cachedMetadata = null
  metadataLoaded = false
}

function getOrcaDir(): string {
  if (testBaseDir) {
    return join(testBaseDir, '.orca')
  }
  return join(homedir(), '.orca')
}

function getCredentialsPath(): string {
  return join(getOrcaDir(), 'trello-credentials.json')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyMetadata(): TrelloCredentialsMetadata {
  return {
    apiKey: '',
    viewer: null,
    hasToken: false
  }
}

function readStoredCredentials(): Partial<StoredTrelloCredentials> | null {
  const path = getCredentialsPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<StoredTrelloCredentials>
  } catch {
    return null
  }
}

function readMetadataFromDisk(): TrelloCredentialsMetadata {
  const parsed = readStoredCredentials()
  if (!parsed) {
    return emptyMetadata()
  }
  return {
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    viewer:
      parsed.viewer && typeof parsed.viewer === 'object' ? (parsed.viewer as TrelloViewer) : null,
    hasToken: typeof parsed.tokenEncrypted === 'string' || typeof parsed.token === 'string'
  }
}

export function getTrelloCredentialsMetadata(): TrelloCredentialsMetadata {
  if (!metadataLoaded || !cachedMetadata) {
    cachedMetadata = readMetadataFromDisk()
    metadataLoaded = true
  }
  return cachedMetadata
}

export function loadTrelloToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken
  }
  const parsed = readStoredCredentials()
  if (!parsed) {
    return null
  }
  if (typeof parsed.tokenEncrypted === 'string') {
    try {
      cachedToken = safeStorage.decryptString(Buffer.from(parsed.tokenEncrypted, 'base64'))
      return cachedToken
    } catch {
      return null
    }
  }
  if (typeof parsed.token === 'string') {
    cachedToken = parsed.token
    return cachedToken
  }
  return null
}

export function saveTrelloCredentials(apiKey: string, token: string, viewer: TrelloViewer): void {
  ensureOrcaDir()

  const toWrite: StoredTrelloCredentials = {
    version: 1,
    apiKey,
    viewer
  }
  if (safeStorage.isEncryptionAvailable()) {
    toWrite.tokenEncrypted = safeStorage.encryptString(token).toString('base64')
  } else {
    console.warn('[trello] safeStorage encryption unavailable — storing token in plaintext')
    toWrite.token = token
  }

  // Persist first; only update in-memory cache after successful write so a
  // failure leaves the previous credential state intact.
  writeFileSync(getCredentialsPath(), JSON.stringify(toWrite, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })

  cachedToken = token
  cachedMetadata = { apiKey, viewer, hasToken: true }
  metadataLoaded = true
}

export function updateTrelloViewer(viewer: TrelloViewer): void {
  const metadata = getTrelloCredentialsMetadata()
  cachedMetadata = { ...metadata, viewer }
  metadataLoaded = true

  const token = loadTrelloToken()
  if (metadata.apiKey && token) {
    saveTrelloCredentials(metadata.apiKey, token, viewer)
  }
}

export function deleteTrelloCredentials(): void {
  cachedToken = null
  cachedMetadata = null
  metadataLoaded = false
  try {
    unlinkSync(getCredentialsPath())
  } catch {
    // File may not exist; disconnect remains idempotent.
  }
}
