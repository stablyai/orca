import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SentryConnection, SentryOrganization } from '../../shared/sentry-types'
import {
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import { isSentryRecord } from './sentry-value-guards'

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
    const parsed: unknown = JSON.parse(value)
    if (!isSentryRecord(parsed) || typeof parsed.token !== 'string' || !parsed.token) {
      return null
    }
    const connection = parseConnectionValue(parsed)
    return connection ? { ...connection, token: parsed.token } : null
  } catch {
    return null
  }
}

function parseOrganization(value: unknown): SentryOrganization | null {
  if (
    !isSentryRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.slug !== 'string' ||
    typeof value.name !== 'string'
  ) {
    return null
  }
  return { id: value.id, slug: value.slug, name: value.name }
}

function parseConnectionValue(value: unknown): SentryConnectionFile | null {
  if (!isSentryRecord(value) || value.version !== 1 || typeof value.baseUrl !== 'string') {
    return null
  }
  const organization = parseOrganization(value.organization)
  const organizations = Array.isArray(value.organizations)
    ? value.organizations.map(parseOrganization)
    : []
  if (!organization || organizations.some((entry) => entry === null)) {
    return null
  }
  return {
    version: 1,
    baseUrl: value.baseUrl,
    organization,
    organizations: organizations.filter((entry): entry is SentryOrganization => entry !== null)
  }
}

function readLegacyCredential(): SentryCredentialRecord | null {
  let value: SentryConnectionFile | null
  try {
    value = parseConnectionValue(JSON.parse(readFileSync(connectionPath(), 'utf8')))
  } catch {
    return null
  }
  const token = credentialFileHasContent(tokenPath())
    ? readStoredCredentialToken('Sentry', readFileSync(tokenPath()))
    : null
  if (!value || !token) {
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
