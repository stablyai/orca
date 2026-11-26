import { inCredentialFileOrder, credentialFileExists } from '../credentials/credential-file-io'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeEncryptedCredential } from '../credentials/integration-credential-file'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira/jira-types'
import { createIntegrationStateFileCache } from '../credentials/integration-state-file-cache'
import { isJiraGatewayBaseUrl } from './gateway-base-url'
import { resolveJiraAuthType } from './site-identity'
import { createIntegrationTokenFileCache } from '../credentials/integration-token-file-cache'

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

export async function getCredentialError(siteId: string): Promise<string | undefined> {
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

async function ensureOrcaDir(): Promise<void> {
  const dir = getOrcaDir()
  if (!(await credentialFileExists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

async function ensureTokenDir(): Promise<void> {
  const dir = getTokenDir()
  if (!(await credentialFileExists(dir))) {
    await mkdir(dir, { recursive: true })
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

export async function hasStoredToken(siteId: string): Promise<boolean> {
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
  // An emailless server record is a PAT site; coercing it to Cloud would drop it and orphan its token.
  const authType =
    record.authType === 'server' && !record.email
      ? 'server'
      : resolveJiraAuthType(record.siteUrl, record.authType)
  if (authType !== 'server' && !record.email && !isJiraGatewayBaseUrl(record.apiBaseUrl)) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    authType,
    ...(authType !== 'server' && isJiraGatewayBaseUrl(record.apiBaseUrl)
      ? { apiBaseUrl: record.apiBaseUrl }
      : {})
  }
}

async function readSiteFileFromDisk(): Promise<JiraSiteFile> {
  const path = getSiteFilePath()
  if (!(await credentialFileExists(path))) {
    return emptySiteFile()
  }
  try {
    const parsed: Partial<JiraSiteFile> = JSON.parse(await readFile(path, { encoding: 'utf-8' }))
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

export async function getSiteFile(): Promise<JiraSiteFile> {
  const file = await inCredentialFileOrder(getSiteFilePath(), () => siteFileCache.get())
  return selectableSiteFile(file)
}

async function selectableSiteFile(file: JiraSiteFile): Promise<JiraSiteFile> {
  const presence = await Promise.all(file.sites.map((site) => hasStoredToken(site.id)))
  const sites = file.sites.filter((_, index) => presence[index])
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

export async function writeSiteFile(file: JiraSiteFile): Promise<void> {
  return inCredentialFileOrder(getSiteFilePath(), async () => {
    await ensureOrcaDir()
    const next = await selectableSiteFile(file)
    await writeFile(getSiteFilePath(), JSON.stringify(next, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    siteFileCache.invalidate()
  })
}

export async function readToken(siteId: string): Promise<string | null> {
  return tokenFileCache.read(siteId)
}

/** How a site's stored token sits on disk, or null when none is stored. */
export async function getSiteTokenProtection(
  siteId: string
): Promise<SecretAtRestProtection | null> {
  return readCredentialFileProtection(getTokenPath(siteId))
}

export async function saveToken(siteId: string, apiToken: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath(siteId)}.mutation`, async () => {
    await ensureOrcaDir()
    await ensureTokenDir()
    await writeEncryptedCredential('Jira', getTokenPath(siteId), apiToken)
    // The next action reads the actual file, including any overlapping writer's replacement.
    tokenFileCache.forget(siteId)
  })
}

export async function deleteToken(siteId: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath(siteId)}.mutation`, async () => {
    tokenFileCache.forget(siteId)
    try {
      await unlink(getTokenPath(siteId))
    } catch {}
  })
}

export function inSiteRegistryOrder<T>(run: () => Promise<T>): Promise<T> {
  return inCredentialFileOrder(`${getSiteFilePath()}.registry`, run)
}
