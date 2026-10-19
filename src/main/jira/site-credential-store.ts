import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeEncryptedCredential } from '../integration-credential-file'
import { readCredentialFileProtection } from '../credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira-types'
import { createIntegrationStateFileCache } from '../integration-state-file-cache'
import { isJiraGatewayBaseUrl } from './gateway-base-url'
import { createIntegrationTokenFileCache } from '../integration-token-file-cache'

export type JiraSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: JiraSiteSelection | null
  sites: JiraSite[]
}

const siteFileCache = createIntegrationStateFileCache({
  filePath: getSiteFilePath,
  readFromDisk: readSiteFileFromDisk
})
const tokenFileCache = createIntegrationTokenFileCache({ service: 'Jira', filePath: getTokenPath })

export function getCredentialError(siteId: string): string | undefined {
  return tokenFileCache.error(siteId)
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getSiteFilePath(): string {
  return join(getOrcaDir(), 'jira-sites.json')
}

export function getTokenDir(): string {
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

export function hasStoredToken(siteId: string): boolean {
  return tokenFileCache.has(siteId)
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
  if (record.apiBaseUrl !== undefined && !isJiraGatewayBaseUrl(record.apiBaseUrl)) {
    return null
  }
  if (record.authType !== 'server' && !record.email && !isJiraGatewayBaseUrl(record.apiBaseUrl)) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    // Sites saved before self-hosted support have no authType; they are Cloud.
    authType: record.authType === 'server' ? 'server' : 'cloud',
    ...(record.authType !== 'server' && isJiraGatewayBaseUrl(record.apiBaseUrl)
      ? { apiBaseUrl: record.apiBaseUrl }
      : {})
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
    return { version: 1, activeSiteId, selectedSiteId, sites }
  } catch {
    return emptySiteFile()
  }
}

export function getSiteFile(): JiraSiteFile {
  const file = siteFileCache.get()
  return selectableSiteFile(file)
}

function selectableSiteFile(file: JiraSiteFile): JiraSiteFile {
  const sites = file.sites.filter((site) => hasStoredToken(site.id))
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

  return {
    version: 1,
    activeSiteId,
    selectedSiteId,
    sites
  }
}

export function writeSiteFile(file: JiraSiteFile): void {
  ensureOrcaDir()
  const next = selectableSiteFile(file)
  writeFileSync(getSiteFilePath(), JSON.stringify(next, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  siteFileCache.invalidate()
}

export function readToken(siteId: string): string | null {
  return tokenFileCache.read(siteId)
}

/** How a site's stored token sits on disk, or null when none is stored. */
export function getSiteTokenProtection(siteId: string): SecretAtRestProtection | null {
  return readCredentialFileProtection(getTokenPath(siteId))
}

export function saveToken(siteId: string, apiToken: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedCredential('Jira', getTokenPath(siteId), apiToken)
  // The next action reads the actual file, including any overlapping writer's replacement.
  tokenFileCache.forget(siteId)
}

export function deleteToken(siteId: string): void {
  tokenFileCache.forget(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}
