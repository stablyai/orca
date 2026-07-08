import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import type { JiraSite, JiraSiteSelection } from '../../shared/types'
import { normalizeStoredJiraSiteUrl } from './jira-site-url'

export type JiraSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: JiraSiteSelection | null
  sites: JiraSite[]
}

let cachedSiteFile: JiraSiteFile | null = null
let siteFileLoaded = false
const cachedSecrets = new Map<string, string>()
// Why: decrypt failures are recorded per site so status can explain failing
// reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getSiteFilePath(): string {
  return join(getOrcaDir(), 'jira-sites.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'jira-tokens')
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

function emptySiteFile(): JiraSiteFile {
  return {
    version: 1,
    activeSiteId: null,
    selectedSiteId: null,
    sites: []
  }
}

export function hasJiraSiteSecret(siteId: string): boolean {
  return cachedSecrets.has(siteId) || credentialFileHasContent(getTokenPath(siteId))
}

function normalizeDeploymentType(value: unknown): JiraSite['deploymentType'] {
  return value === 'server' ? 'server' : 'cloud'
}

function normalizeAuthMode(
  deploymentType: JiraSite['deploymentType'],
  value: unknown
): JiraSite['authMode'] {
  if (deploymentType === 'cloud') {
    return 'basic'
  }
  return value === 'bearer' ? 'bearer' : 'basic'
}

function normalizeSite(input: unknown): JiraSite | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.siteUrl !== 'string' ||
    typeof record.email !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof record.accountId !== 'string'
  ) {
    return null
  }
  const deploymentType = normalizeDeploymentType(record.deploymentType)
  const authMode = normalizeAuthMode(deploymentType, record.authMode)
  const siteUrl = normalizeStoredJiraSiteUrl(record.siteUrl)
  if (!siteUrl) {
    return null
  }
  const viewerUserId =
    typeof record.viewerUserId === 'string' && record.viewerUserId.trim()
      ? record.viewerUserId
      : record.accountId
  const site: JiraSite = {
    id: record.id,
    siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    viewerUserId,
    deploymentType,
    authMode
  }
  if (typeof record.authUsername === 'string' && record.authUsername.trim()) {
    site.authUsername = record.authUsername
  }
  return site
}

function writeMigratedSiteFileIfNeeded(
  filePath: string,
  parsed: Partial<JiraSiteFile>,
  file: JiraSiteFile
): void {
  if (JSON.stringify(parsed.sites ?? []) === JSON.stringify(file.sites)) {
    return
  }
  try {
    writeFileSync(filePath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // Migration is best-effort; in-memory normalized metadata is still used.
  }
}

function readSiteFileFromDisk(): JiraSiteFile {
  const path = getSiteFilePath()
  if (!existsSync(path)) {
    return emptySiteFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<JiraSiteFile>
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites
          .map((site) => normalizeSite(site))
          .filter((site): site is JiraSite => site !== null)
          .filter((site) => hasJiraSiteSecret(site.id))
      : []
    const activeSiteId =
      typeof parsed.activeSiteId === 'string' &&
      sites.some((site) => site.id === parsed.activeSiteId)
        ? parsed.activeSiteId
        : (sites[0]?.id ?? null)
    const selectedSiteId =
      parsed.selectedSiteId === 'all' ||
      (typeof parsed.selectedSiteId === 'string' &&
        sites.some((site) => site.id === parsed.selectedSiteId))
        ? parsed.selectedSiteId
        : activeSiteId
    const file = { version: 1 as const, activeSiteId, selectedSiteId, sites }
    writeMigratedSiteFileIfNeeded(path, parsed, file)
    return file
  } catch {
    return emptySiteFile()
  }
}

export function getSiteFile(): JiraSiteFile {
  if (!siteFileLoaded || !cachedSiteFile) {
    cachedSiteFile = readSiteFileFromDisk()
    siteFileLoaded = true
  }
  return cachedSiteFile
}

export function writeSiteFile(file: JiraSiteFile): void {
  ensureOrcaDir()
  const sites = file.sites.filter((site) => hasJiraSiteSecret(site.id))
  const activeSiteId =
    file.activeSiteId && sites.some((site) => site.id === file.activeSiteId)
      ? file.activeSiteId
      : (sites[0]?.id ?? null)
  const selectedSiteId =
    file.selectedSiteId === 'all'
      ? 'all'
      : file.selectedSiteId && sites.some((site) => site.id === file.selectedSiteId)
        ? file.selectedSiteId
        : activeSiteId

  const nextFile: JiraSiteFile = {
    version: 1,
    activeSiteId,
    selectedSiteId,
    sites
  }
  writeFileSync(getSiteFilePath(), JSON.stringify(nextFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  cachedSiteFile = nextFile
  siteFileLoaded = true
}

function writeEncryptedToken(path: string, secret: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(secret), { mode: 0o600 })
    return
  }
  console.warn('[jira] safeStorage encryption unavailable - storing token in plaintext')
  writeFileSync(path, secret, { encoding: 'utf-8', mode: 0o600 })
}

export function readJiraSiteSecret(siteId: string): string | null {
  const cached = cachedSecrets.get(siteId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(siteId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Jira', readFileSync(path))
    if (token) {
      cachedSecrets.set(siteId, token)
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

export function saveJiraSiteSecret(siteId: string, secret: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(siteId), secret)
  cachedSecrets.set(siteId, secret)
  credentialErrors.delete(siteId)
}

export function deleteJiraSiteSecret(siteId: string): void {
  cachedSecrets.delete(siteId)
  credentialErrors.delete(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

export function getJiraCredentialError(siteId: string): string | undefined {
  return credentialErrors.get(siteId)
}
