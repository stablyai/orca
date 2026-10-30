import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCredentialFileProtection } from '../credential-file-protection'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type { YouTrackUser } from '../../shared/youtrack-types'
import { isRawRecord } from './raw-record'

export type YouTrackSiteFile = {
  version: 1
  baseUrl: string
  viewer: YouTrackUser
  allowInsecureTls?: boolean
}

let cachedSite: YouTrackSiteFile | null | undefined
let cachedToken: string | null = null
let credentialError: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getSitePath(): string {
  return join(getOrcaDir(), 'youtrack.json')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'youtrack-token.enc')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function normalizeSiteFile(value: unknown): YouTrackSiteFile | null {
  if (!isRawRecord(value) || !isRawRecord(value.viewer)) {
    return null
  }
  const record = value
  const viewer = value.viewer
  if (
    typeof record.baseUrl !== 'string' ||
    typeof viewer.id !== 'string' ||
    typeof viewer.login !== 'string' ||
    typeof viewer.fullName !== 'string'
  ) {
    return null
  }
  return {
    version: 1,
    baseUrl: record.baseUrl,
    ...(record.allowInsecureTls === true ? { allowInsecureTls: true } : {}),
    viewer: {
      id: viewer.id,
      login: viewer.login,
      fullName: viewer.fullName,
      email: typeof viewer.email === 'string' ? viewer.email : null,
      ...(typeof viewer.avatarUrl === 'string' ? { avatarUrl: viewer.avatarUrl } : {})
    }
  }
}

export function getSite(): YouTrackSiteFile | null {
  if (cachedSite !== undefined) {
    return cachedSite
  }
  try {
    cachedSite = existsSync(getSitePath())
      ? normalizeSiteFile(JSON.parse(readFileSync(getSitePath(), 'utf-8')))
      : null
  } catch {
    cachedSite = null
  }
  // Why: a site without a token is a half-finished connect; treat it as disconnected.
  if (cachedSite && !credentialFileHasContent(getTokenPath())) {
    cachedSite = null
  }
  return cachedSite
}

export function readToken(): string | null {
  if (cachedToken) {
    return cachedToken
  }
  if (!existsSync(getTokenPath())) {
    return null
  }
  try {
    cachedToken = readStoredCredentialToken('YouTrack', readFileSync(getTokenPath()))
    credentialError = null
    return cachedToken
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
      throw error
    }
    return null
  }
}

export function getCredentialError(): string | null {
  return credentialError
}

export function getTokenProtection(): SecretAtRestProtection | null {
  return readCredentialFileProtection(getTokenPath())
}

export function saveSite(site: YouTrackSiteFile, token: string): void {
  ensureOrcaDir()
  writeEncryptedCredential('YouTrack', getTokenPath(), token)
  writeFileSync(getSitePath(), JSON.stringify(site, null, 2), { encoding: 'utf-8', mode: 0o600 })
  cachedSite = site
  cachedToken = token
  credentialError = null
}

export function clearSite(): void {
  cachedSite = null
  cachedToken = null
  credentialError = null
  for (const path of [getTokenPath(), getSitePath()]) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
}
