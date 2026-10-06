import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { TodoistViewer } from '../../shared/todoist-types'
import { isRecord } from './todoist-mapping'

// Why: the viewer lives in plaintext next to the encrypted token so status
// polls render the account without a keychain prompt (same split as Bitbucket).
let cachedViewer: TodoistViewer | null | undefined
let cachedToken: string | null = null
let credentialError: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getViewerPath(): string {
  return join(getOrcaDir(), 'todoist-account.json')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'todoist-token.enc')
}

function readViewerFromDisk(): TodoistViewer | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getViewerPath(), 'utf-8'))
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== 'string' ||
      typeof parsed.fullName !== 'string' ||
      typeof parsed.email !== 'string'
    ) {
      return null
    }
    return { id: parsed.id, fullName: parsed.fullName, email: parsed.email }
  } catch {
    return null
  }
}

export function getStoredTodoistViewer(): TodoistViewer | null {
  if (cachedViewer === undefined) {
    cachedViewer = credentialFileHasContent(getTokenPath()) ? readViewerFromDisk() : null
  }
  return cachedViewer
}

export function getTodoistCredentialError(): string | null {
  return credentialError
}

export function saveTodoistCredential(token: string, viewer: TodoistViewer): void {
  mkdirSync(getOrcaDir(), { recursive: true })
  writeEncryptedCredential('Todoist', getTokenPath(), token)
  writeCredentialFileAtomic(getViewerPath(), Buffer.from(JSON.stringify(viewer), 'utf-8'))
  cachedToken = token
  cachedViewer = viewer
  credentialError = null
}

/** Throws CredentialDecryptionError when the saved token cannot be decrypted. */
export function loadTodoistToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken
  }
  const path = getTokenPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    cachedToken = readStoredCredentialToken('Todoist', readFileSync(path))
    credentialError = null
    return cachedToken
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
    }
    throw error
  }
}

/** Throws when a file cannot be deleted, so a failed disconnect is not reported as success. */
export function clearTodoistCredential(): void {
  // Why: undefined re-reads disk, so a token that survives a failed delete still shows as connected.
  cachedToken = null
  cachedViewer = undefined
  credentialError = null
  for (const path of [getTokenPath(), getViewerPath()]) {
    rmSync(path, { force: true })
  }
}
