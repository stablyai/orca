import { dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { RedmineSite, RedmineSiteSelection } from '../../shared/redmine-types'
import {
  getRedmineSiteFilePath,
  getRedmineTokenDir,
  getRedmineTokenPath
} from './redmine-credential-paths'

export type RedmineSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: RedmineSiteSelection | null
  sites: RedmineSite[]
}

let cachedSiteFile: RedmineSiteFile | null = null
let siteFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per site so getStatus can explain failing
// reads without re-touching the keychain on every status poll.
export const credentialErrors = new Map<string, string>()

function ensureOrcaDir(): void {
  const dir = dirname(getRedmineSiteFilePath())
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptySiteFile(): RedmineSiteFile {
  return {
    version: 1,
    activeSiteId: null,
    selectedSiteId: null,
    sites: []
  }
}

export function hasStoredToken(siteId: string): boolean {
  return cachedTokens.has(siteId) || credentialFileHasContent(getRedmineTokenPath(siteId))
}

function normalizeSite(input: unknown): RedmineSite | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.siteUrl !== 'string' ||
    typeof record.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    displayName: record.displayName,
    hasToken: typeof record.hasToken === 'boolean' ? record.hasToken : false
  }
}

function readSiteFileFromDisk(): RedmineSiteFile {
  const path = getRedmineSiteFilePath()
  if (!existsSync(path)) {
    return emptySiteFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<RedmineSiteFile>
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites
          .map((site) => normalizeSite(site))
          .filter((site): site is RedmineSite => site !== null)
          .map((site) => ({ ...site, hasToken: hasStoredToken(site.id) || site.hasToken }))
      : []
    const activeSiteId =
      typeof parsed.activeSiteId === 'string' &&
      sites.some((site) => site.id === parsed.activeSiteId)
        ? parsed.activeSiteId
        : (sites[0]?.id ?? null)
    const selectedSiteId =
      typeof parsed.selectedSiteId === 'string' &&
      sites.some((site) => site.id === parsed.selectedSiteId)
        ? parsed.selectedSiteId
        : activeSiteId
    return { version: 1, activeSiteId, selectedSiteId, sites }
  } catch {
    return emptySiteFile()
  }
}

export function getSiteFile(): RedmineSiteFile {
  if (!siteFileLoaded || !cachedSiteFile) {
    cachedSiteFile = readSiteFileFromDisk()
    siteFileLoaded = true
  }
  return cachedSiteFile
}

export function writeSiteFile(file: RedmineSiteFile): void {
  const sites = file.sites.map((site) => ({
    ...site,
    hasToken: hasStoredToken(site.id) || site.hasToken
  }))
  const activeSiteId =
    file.activeSiteId && sites.some((site) => site.id === file.activeSiteId)
      ? file.activeSiteId
      : (sites[0]?.id ?? null)
  const selectedSiteId =
    typeof file.selectedSiteId === 'string' && sites.some((site) => site.id === file.selectedSiteId)
      ? file.selectedSiteId
      : activeSiteId

  cachedSiteFile = { version: 1, activeSiteId, selectedSiteId, sites }
  siteFileLoaded = true
  writeFileSync(getRedmineSiteFilePath(), JSON.stringify(cachedSiteFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

export function readToken(siteId: string): string | null {
  const cached = cachedTokens.get(siteId)
  if (cached !== undefined) {
    return cached
  }
  const path = getRedmineTokenPath(siteId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('Redmine', raw)
    if (token) {
      cachedTokens.set(siteId, token)
    }
    credentialErrors.delete(siteId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(siteId, error.message)
      throw error
    }
    return null
  }
}

export function saveToken(siteId: string, apiToken: string): void {
  ensureOrcaDir()
  const tokenDir = getRedmineTokenDir()
  if (!existsSync(tokenDir)) {
    mkdirSync(tokenDir, { recursive: true })
  }
  writeEncryptedCredential('Redmine', getRedmineTokenPath(siteId), apiToken)
  cachedTokens.set(siteId, apiToken)
  credentialErrors.delete(siteId)
}

export function deleteToken(siteId: string): void {
  cachedTokens.delete(siteId)
  credentialErrors.delete(siteId)
  try {
    unlinkSync(getRedmineTokenPath(siteId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}

// Test hook so credential caching does not leak between test cases.
export function _resetRedmineCredentialCache(): void {
  cachedSiteFile = null
  siteFileLoaded = false
  cachedTokens.clear()
  credentialErrors.clear()
}
