import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

const orcaDir = (): string => join(homedir(), '.orca')
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
  writeEncryptedCredential('Sentry', tokenPath(), token)
  writeFileSync(
    connectionPath(),
    JSON.stringify({ version: 1, ...connection, organizations } satisfies SentryConnectionFile),
    { encoding: 'utf8', mode: 0o600 }
  )
}

export function readSentryToken(): string | null {
  if (!credentialFileHasContent(tokenPath())) {
    return null
  }
  return readStoredCredentialToken('Sentry', readFileSync(tokenPath()))
}

export function readSentryConnectionFile(): SentryConnectionFile | null {
  try {
    const value = JSON.parse(readFileSync(connectionPath(), 'utf8')) as SentryConnectionFile
    if (
      value.version !== 1 ||
      typeof value.baseUrl !== 'string' ||
      !value.organization ||
      !Array.isArray(value.organizations)
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export function clearSentryCredential(): void {
  for (const path of [tokenPath(), connectionPath()]) {
    try {
      if (existsSync(path)) {
        unlinkSync(path)
      }
    } catch {
      // A missing credential is already disconnected.
    }
  }
}
