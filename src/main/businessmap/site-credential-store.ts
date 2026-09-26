import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { BusinessmapSite } from '../../shared/businessmap-types'

export type BusinessmapSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: string | null
  sites: BusinessmapSite[]
}

let cachedSiteFile: BusinessmapSiteFile | null = null
let siteFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per site so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
export const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getSiteFilePath(): string {
  return join(getOrcaDir(), 'businessmap-sites.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'businessmap-tokens')
}

function getTokenPath(siteId: string): string {
  return join(getTokenDir(), `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptySiteFile(): BusinessmapSiteFile {
  return { version: 1, activeSiteId: null, selectedSiteId: null, sites: [] }
}

export function hasStoredToken(siteId: string): boolean {
  return cachedTokens.has(siteId) || credentialFileHasContent(getTokenPath(siteId))
}

function normalizeDomain(value: unknown): 'businessmap.io' | 'kanbanize.com' {
  return value === 'kanbanize.com' ? 'kanbanize.com' : 'businessmap.io'
}

function normalizeSite(input: unknown): BusinessmapSite | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(input)) {
    record[key] = entry
  }
  if (typeof record.id !== 'string' || typeof record.subdomain !== 'string') {
    return null
  }
  const site: BusinessmapSite = {
    id: record.id,
    subdomain: record.subdomain,
    domain: normalizeDomain(record.domain)
  }
  if (typeof record.displayName === 'string') {
    site.displayName = record.displayName
  }
  if (typeof record.accountName === 'string') {
    site.accountName = record.accountName
  }
  return site
}

function readSiteFileFromDisk(): BusinessmapSiteFile {
  const path = getSiteFilePath()
  if (!existsSync(path)) {
    return emptySiteFile()
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, { encoding: 'utf-8' }))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptySiteFile()
    }
    const fileRecord: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(parsed)) {
      fileRecord[key] = entry
    }
    const sites = Array.isArray(fileRecord.sites)
      ? fileRecord.sites
          .map((site) => normalizeSite(site))
          .filter((site): site is BusinessmapSite => site !== null)
          .filter((site) => hasStoredToken(site.id))
      : []
    const activeSiteId =
      typeof fileRecord.activeSiteId === 'string' &&
      sites.some((site) => site.id === fileRecord.activeSiteId)
        ? String(fileRecord.activeSiteId)
        : (sites[0]?.id ?? null)
    const selectedSiteId =
      typeof fileRecord.selectedSiteId === 'string' &&
      sites.some((site) => site.id === fileRecord.selectedSiteId)
        ? String(fileRecord.selectedSiteId)
        : activeSiteId
    return { version: 1, activeSiteId, selectedSiteId, sites }
  } catch {
    return emptySiteFile()
  }
}

export function getSiteFile(): BusinessmapSiteFile {
  if (!siteFileLoaded || !cachedSiteFile) {
    cachedSiteFile = readSiteFileFromDisk()
    siteFileLoaded = true
  }
  return cachedSiteFile
}

export function writeSiteFile(file: BusinessmapSiteFile): void {
  ensureOrcaDir()
  const sites = file.sites.filter((site) => hasStoredToken(site.id))
  const activeSiteId =
    file.activeSiteId && sites.some((site) => site.id === file.activeSiteId)
      ? file.activeSiteId
      : (sites[0]?.id ?? null)
  const selectedSiteId =
    file.selectedSiteId && sites.some((site) => site.id === file.selectedSiteId)
      ? file.selectedSiteId
      : activeSiteId
  cachedSiteFile = { version: 1, activeSiteId, selectedSiteId, sites }
  siteFileLoaded = true
  // Site list holds no secrets: plaintext JSON so a reinstalled keychain still resolves sites.
  writeFileSync(getSiteFilePath(), JSON.stringify(cachedSiteFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}
export function readToken(siteId: string): string | null {
  const cached = cachedTokens.get(siteId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(siteId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Businessmap', readFileSync(path))
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

export function saveToken(siteId: string, apiKey: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  // Per-site API keys stay encrypted; only the site list above is plaintext.
  writeEncryptedCredential('Businessmap', getTokenPath(siteId), apiKey)
  cachedTokens.set(siteId, apiKey)
  credentialErrors.delete(siteId)
}

export function deleteToken(siteId: string): void {
  cachedTokens.delete(siteId)
  credentialErrors.delete(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}
