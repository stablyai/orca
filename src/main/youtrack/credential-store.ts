import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inCredentialFileOrder, stageCredentialFile } from '../credentials/credential-file-io'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../credentials/integration-credential-file'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { YouTrackUser } from '../../shared/youtrack-types'
import { isRawRecord } from './raw-record'

export type YouTrackSiteFile = {
  version: 1
  baseUrl: string
  viewer: YouTrackUser
  allowInsecureTls?: boolean
}

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

async function readSite(): Promise<YouTrackSiteFile | null> {
  try {
    return normalizeSiteFile(JSON.parse(await readFile(getSitePath(), 'utf8')))
  } catch {
    return null
  }
}

function readTokenBytes(): Promise<Buffer | null> {
  return readFile(getTokenPath()).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
}

export function readConnection(): Promise<{ site: YouTrackSiteFile; token: string } | null> {
  return inCredentialFileOrder(getSitePath(), async () => {
    const site = await readSite()
    const raw = site ? await readTokenBytes() : null
    if (!site || !raw) {
      return null
    }
    try {
      const token = readStoredCredentialToken('YouTrack', raw)
      credentialError = null
      return token ? { site, token } : null
    } catch (error) {
      if (error instanceof CredentialDecryptionError) {
        credentialError = error.message
      }
      throw error
    }
  })
}

export function readConnectionStatus(): Promise<{
  site: YouTrackSiteFile | null
  credentialError: string | null
  credentialProtection: SecretAtRestProtection | null
}> {
  return inCredentialFileOrder(getSitePath(), async () => {
    const site = (await credentialFileHasContent(getTokenPath())) ? await readSite() : null
    return {
      site,
      credentialError,
      credentialProtection: site ? await readCredentialFileProtection(getTokenPath()) : null
    }
  })
}

export function saveSite(site: YouTrackSiteFile, token: string): Promise<void> {
  return inCredentialFileOrder(getSitePath(), async () => {
    await mkdir(getOrcaDir(), { recursive: true, mode: 0o700 })
    const previousToken = await readTokenBytes()
    await writeEncryptedCredential('YouTrack', getTokenPath(), token)
    try {
      await stageCredentialFile(getSitePath(), JSON.stringify(site, null, 2), { syncFile: true })
    } catch (error) {
      await (previousToken
        ? writeCredentialFileAtomic(getTokenPath(), previousToken)
        : rm(getTokenPath(), { force: true }))
      throw error
    }
    credentialError = null
  })
}

export function clearSite(): Promise<void> {
  return inCredentialFileOrder(getSitePath(), async () => {
    await rm(getTokenPath(), { force: true })
    await rm(getSitePath(), { force: true })
    credentialError = null
  })
}
