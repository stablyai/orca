import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import type { MantisBTSite, MantisBTSiteSelection } from '../../shared/mantisbt-types'

export type MantisBTSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: MantisBTSiteSelection | null
  sites: MantisBTSite[]
}

let cachedSiteFile: MantisBTSiteFile | null = null
let siteFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per site so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
export const credentialErrors = new Map<string, string>()
let legacyCredentialsMigrationChecked = false

// Why: this store was named mantis-*/Mantis before the mantisBT rename. A
// one-time, best-effort move keeps any credentials a Phase 1 adopter already
// saved from being silently orphaned under the old paths.
function migrateLegacyCredentialsIfNeeded(): void {
  if (legacyCredentialsMigrationChecked) {
    return
  }
  legacyCredentialsMigrationChecked = true
  const dir = join(homedir(), '.orca')
  const legacySitePath = join(dir, 'mantis-sites.json')
  const legacyTokenDir = join(dir, 'mantis-tokens')
  try {
    if (existsSync(legacySitePath) && !existsSync(join(dir, 'mantisBT-sites.json'))) {
      renameSync(legacySitePath, join(dir, 'mantisBT-sites.json'))
    }
    if (existsSync(legacyTokenDir) && !existsSync(join(dir, 'mantisBT-tokens'))) {
      renameSync(legacyTokenDir, join(dir, 'mantisBT-tokens'))
    }
  } catch {
    // Why: a failed one-time migration must not crash MantisBT status reads;
    // the legacy files are left in place and the user can reconnect.
  }
}

function getOrcaDir(): string {
  migrateLegacyCredentialsIfNeeded()
  return join(homedir(), '.orca')
}

function getSiteFilePath(): string {
  return join(getOrcaDir(), 'mantisBT-sites.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'mantisBT-tokens')
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

function emptySiteFile(): MantisBTSiteFile {
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

function normalizeSite(input: unknown): MantisBTSite | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by the `typeof input !== 'object'` check above; every field is re-validated with `typeof` below before use.
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.siteUrl !== 'string' ||
    typeof record.userId !== 'string' ||
    typeof record.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    userId: record.userId,
    displayName: record.displayName,
    // Why: sites saved before probeMantisBTConnection existed have neither
    // field on disk — default to the combination connect() always used back
    // then (RFC 6750 Bearer, pretty REST URL) so they keep working exactly
    // as they did until the user reconnects and a fresh probe corrects it.
    authScheme: record.authScheme === 'legacy' ? 'legacy' : 'bearer',
    usePhpIndexPath: record.usePhpIndexPath === true
  }
}

function readSiteFileFromDisk(): MantisBTSiteFile {
  const path = getSiteFilePath()
  if (!existsSync(path)) {
    return emptySiteFile()
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse returns `any`; every field is defensively validated (Array.isArray/typeof) below before use, and normalizeSite re-validates each site entry independently.
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<MantisBTSiteFile>
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites
          .map((site) => normalizeSite(site))
          .filter((site): site is MantisBTSite => site !== null)
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

export function getSiteFile(): MantisBTSiteFile {
  if (!siteFileLoaded || !cachedSiteFile) {
    cachedSiteFile = readSiteFileFromDisk()
    siteFileLoaded = true
  }
  return cachedSiteFile
}

export function writeSiteFile(file: MantisBTSiteFile): void {
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

function writeEncryptedToken(path: string, apiToken: string): void {
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(path, getSecretStore().encryptString(apiToken), { mode: 0o600 })
    return
  }
  console.warn('[mantisBT] secret encryption unavailable — storing token in plaintext')
  writeFileSync(path, apiToken, { encoding: 'utf-8', mode: 0o600 })
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
    const token = readStoredCredentialToken('MantisBT', raw)
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
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(siteId), apiToken)
  cachedTokens.set(siteId, apiToken)
  credentialErrors.delete(siteId)
}

export function deleteToken(siteId: string): void {
  cachedTokens.delete(siteId)
  credentialErrors.delete(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch (error) {
    // Why: only a missing file means "already gone" — a permission or I/O
    // failure here must surface, or the caller reports a successful
    // disconnect while the token stays readable on disk (CWE-459).
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}
