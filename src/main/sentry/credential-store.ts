import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SentryConnection, SentryOrganization } from '../../shared/sentry-types'
import {
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'

type SentryConnectionFile = {
  version: 1
  baseUrl: string
  organization: SentryOrganization
  organizations: SentryOrganization[]
}

export type SentryCredentialRecord = SentryConnectionFile & { token: string }

const orcaDir = (): string => join(homedir(), '.orca')
const credentialPath = (): string => join(orcaDir(), 'sentry-credential.enc')
const tokenPath = (): string => join(orcaDir(), 'sentry-token.enc')
const connectionPath = (): string => join(orcaDir(), 'sentry-connection.json')

function ensureOrcaDir(): void {
  mkdirSync(orcaDir(), { recursive: true })
}

export function saveSentryCredential(
  token: string,
  connection: SentryConnection,
  organizations: SentryOrganization[]
): void {
  ensureOrcaDir()
  writeEncryptedCredential(
    'Sentry',
    credentialPath(),
    JSON.stringify({
      version: 1,
      token,
      ...connection,
      organizations
    } satisfies SentryCredentialRecord)
  )
}

function parseCredentialRecord(value: string): SentryCredentialRecord | null {
  try {
    const record = JSON.parse(value) as SentryCredentialRecord
    if (
      record.version !== 1 ||
      typeof record.token !== 'string' ||
      !record.token ||
      typeof record.baseUrl !== 'string' ||
      !record.organization ||
      !Array.isArray(record.organizations)
    ) {
      return null
    }
    return record
  } catch {
    return null
  }
}

function readLegacyCredential(): SentryCredentialRecord | null {
  let value: SentryConnectionFile
  try {
    value = JSON.parse(readFileSync(connectionPath(), 'utf8')) as SentryConnectionFile
  } catch {
    return null
  }
  const token = credentialFileHasContent(tokenPath())
    ? readStoredCredentialToken('Sentry', readFileSync(tokenPath()))
    : null
  if (
    value.version !== 1 ||
    !token ||
    typeof value.baseUrl !== 'string' ||
    !value.organization ||
    !Array.isArray(value.organizations)
  ) {
    return null
  }
  return { ...value, token }
}

export function readSentryCredential(): SentryCredentialRecord | null {
  if (!credentialFileHasContent(credentialPath())) {
    return readLegacyCredential()
  }
  const value = readStoredCredentialToken('Sentry', readFileSync(credentialPath()))
  return value ? parseCredentialRecord(value) : null
}

export function clearSentryCredential(): void {
  for (const path of [credentialPath(), tokenPath(), connectionPath()]) {
    try {
      if (existsSync(path)) {
        unlinkSync(path)
      }
    } catch {
      // A missing credential is already disconnected.
    }
  }
}
