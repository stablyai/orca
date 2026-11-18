import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../credentials/integration-credential-file'
import type { TodoistViewer } from '../../shared/todoist/todoist-types'
import { isRecord } from './todoist-mapping'

// Why: the viewer lives in plaintext next to the encrypted token so status
// polls render the account without a keychain prompt (same split as Bitbucket).
let cachedViewer: TodoistViewer | null | undefined
let cachedToken: string | null = null
let credentialError: string | null = null
// Why: a disk read that started before save/clear must not repopulate the cache with stale data.
let generation = 0

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getViewerPath(): string {
  return join(getOrcaDir(), 'todoist-account.json')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'todoist-token.enc')
}

async function readViewerFromDisk(): Promise<TodoistViewer | null> {
  try {
    // Why: an empty token file means no saved credential, matching token reads.
    if ((await stat(getTokenPath())).size === 0) {
      return null
    }
    const parsed: unknown = JSON.parse(await readFile(getViewerPath(), 'utf-8'))
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

export async function getStoredTodoistViewer(): Promise<TodoistViewer | null> {
  if (cachedViewer === undefined) {
    const readGeneration = generation
    const viewer = await readViewerFromDisk()
    if (readGeneration !== generation) {
      return cachedViewer ?? null
    }
    cachedViewer = viewer
  }
  return cachedViewer
}

export function getTodoistCredentialError(): string | null {
  return credentialError
}

export async function saveTodoistCredential(token: string, viewer: TodoistViewer): Promise<void> {
  await mkdir(getOrcaDir(), { recursive: true })
  // Why: one-shot on user connect; reuses the shared atomic, owner-only credential writer.
  writeEncryptedCredential('Todoist', getTokenPath(), token)
  writeCredentialFileAtomic(getViewerPath(), Buffer.from(JSON.stringify(viewer), 'utf-8'))
  generation += 1
  cachedToken = token
  cachedViewer = viewer
  credentialError = null
}

/** Throws CredentialDecryptionError when the saved token cannot be decrypted. */
export async function loadTodoistToken(): Promise<string | null> {
  if (cachedToken !== null) {
    return cachedToken
  }
  const readGeneration = generation
  const raw = await readFile(getTokenPath()).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (raw === null || readGeneration !== generation) {
    return cachedToken
  }
  try {
    cachedToken = readStoredCredentialToken('Todoist', raw)
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
export async function clearTodoistCredential(): Promise<void> {
  // Why: undefined re-reads disk, so a token that survives a failed delete still shows as connected.
  generation += 1
  cachedToken = null
  cachedViewer = undefined
  credentialError = null
  for (const path of [getTokenPath(), getViewerPath()]) {
    await rm(path, { force: true })
  }
}
