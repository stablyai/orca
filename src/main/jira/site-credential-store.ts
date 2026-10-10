import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCredentialFileProtection } from '../credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  sealCredentialForStorage
} from '../integration-credential-file'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira-types'
import { CredentialWriteOrder } from '../credentials/credential-write-order'

export type JiraSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: JiraSiteSelection | null
  sites: JiraSite[]
}

let cachedSiteFile: JiraSiteFile | null = null
let siteFileLoaded = false
const cachedTokens = new Map<string, string>()
const writeOrder = new CredentialWriteOrder('Jira API token')
// Why: decrypt failures are recorded per site so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
export const credentialErrors = new Map<string, string>()

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

export function hasStoredToken(siteId: string): boolean {
  return cachedTokens.has(siteId) || credentialFileHasContent(getTokenPath(siteId))
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
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    // Sites saved before self-hosted support have no authType; they are Cloud.
    authType: record.authType === 'server' ? 'server' : 'cloud'
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
          .filter((site) => hasStoredToken(site.id))
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
  if (!siteFileLoaded || !cachedSiteFile) {
    cachedSiteFile = readSiteFileFromDisk()
    siteFileLoaded = true
  }
  return cachedSiteFile
}

export function writeSiteFile(file: JiraSiteFile): void {
  ensureOrcaDir()
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

  cachedSiteFile = {
    version: 1,
    activeSiteId,
    selectedSiteId,
    sites
  }
  siteFileLoaded = true
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
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('Jira', raw)
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

/** How a site's stored token sits on disk, or null when none is stored. */
export function getSiteTokenProtection(siteId: string): SecretAtRestProtection | null {
  return readCredentialFileProtection(getTokenPath(siteId))
}

export async function saveToken(siteId: string, apiToken: string): Promise<void> {
  const turn = writeOrder.begin(siteId)
  const sealed = await sealCredentialForStorage('Jira', apiToken)
  turn.assertLatest()
  ensureOrcaDir()
  ensureTokenDir()
  writeFileSync(getTokenPath(siteId), sealed, { mode: 0o600 })
  cachedTokens.set(siteId, apiToken)
  credentialErrors.delete(siteId)
}

export function deleteToken(siteId: string): void {
  writeOrder.begin(siteId)
  cachedTokens.delete(siteId)
  credentialErrors.delete(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}
