import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { credentialFileExists, inCredentialFileOrder } from '../credentials/credential-file-io'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import { createIntegrationStateFileCache } from '../credentials/integration-state-file-cache'
import { createIntegrationTokenFileCache } from '../credentials/integration-token-file-cache'
import { writeEncryptedCredential } from '../credentials/integration-credential-file'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { ClickUpViewer, ClickUpWorkspace } from '../../shared/clickup/clickup-types'

export type ClickUpAccountState = {
  version: 1
  viewer: ClickUpViewer | null
  workspaces: ClickUpWorkspace[]
  selectedWorkspaceId: string | null
}

// One personal token covers every Workspace the account belongs to, so the token store has a single entry.
const TOKEN_ENTRY_ID = 'account'

const accountFileCache = createIntegrationStateFileCache({
  filePath: getAccountFilePath,
  readFromDisk: readAccountFileFromDisk
})
const tokenFileCache = createIntegrationTokenFileCache({
  service: 'ClickUp',
  filePath: getTokenPath
})

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getAccountFilePath(): string {
  return join(getOrcaDir(), 'clickup-account.json')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'clickup-token.enc')
}

function emptyAccountState(): ClickUpAccountState {
  return { version: 1, viewer: null, workspaces: [], selectedWorkspaceId: null }
}

function normalizeViewer(input: unknown): ClickUpViewer | null {
  if (!isRecord(input)) {
    return null
  }
  const record = input
  if (
    typeof record.id !== 'string' ||
    typeof record.username !== 'string' ||
    typeof record.email !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    ...(typeof record.avatarUrl === 'string' ? { avatarUrl: record.avatarUrl } : {})
  }
}

function normalizeWorkspace(input: unknown): ClickUpWorkspace | null {
  if (!isRecord(input)) {
    return null
  }
  const record = input
  if (typeof record.id !== 'string' || typeof record.name !== 'string') {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    ...(typeof record.color === 'string' ? { color: record.color } : {})
  }
}

async function readAccountFileFromDisk(): Promise<ClickUpAccountState> {
  const path = getAccountFilePath()
  if (!(await credentialFileExists(path))) {
    return emptyAccountState()
  }
  try {
    const parsed: Partial<ClickUpAccountState> = JSON.parse(
      await readFile(path, { encoding: 'utf-8' })
    )
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is ClickUpWorkspace => workspace !== null)
      : []
    const selectedWorkspaceId = workspaces.some(
      (workspace) => workspace.id === parsed.selectedWorkspaceId
    )
      ? (parsed.selectedWorkspaceId ?? null)
      : (workspaces[0]?.id ?? null)
    return { version: 1, viewer: normalizeViewer(parsed.viewer), workspaces, selectedWorkspaceId }
  } catch {
    return emptyAccountState()
  }
}

/** The account metadata, or an empty state when no token is stored for it. */
export async function getAccountState(): Promise<ClickUpAccountState> {
  const state = await inCredentialFileOrder(getAccountFilePath(), () => accountFileCache.get())
  return (await tokenFileCache.has(TOKEN_ENTRY_ID)) ? state : emptyAccountState()
}

export async function writeAccountState(state: ClickUpAccountState): Promise<void> {
  return inCredentialFileOrder(getAccountFilePath(), async () => {
    await mkdir(getOrcaDir(), { recursive: true })
    await writeFile(getAccountFilePath(), JSON.stringify(state, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    accountFileCache.invalidate()
  })
}

export async function readToken(): Promise<string | null> {
  return tokenFileCache.read(TOKEN_ENTRY_ID)
}

export async function getCredentialError(): Promise<string | undefined> {
  return tokenFileCache.error(TOKEN_ENTRY_ID)
}

/** How the stored token sits on disk, or null when none is stored. */
export async function getTokenProtection(): Promise<SecretAtRestProtection | null> {
  return readCredentialFileProtection(getTokenPath())
}

export async function saveToken(token: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath()}.mutation`, async () => {
    await mkdir(getOrcaDir(), { recursive: true })
    await writeEncryptedCredential('ClickUp', getTokenPath(), token)
    // The next read goes to the file, including any overlapping writer's replacement.
    tokenFileCache.forget(TOKEN_ENTRY_ID)
  })
}

export async function deleteToken(): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath()}.mutation`, async () => {
    tokenFileCache.forget(TOKEN_ENTRY_ID)
    try {
      await unlink(getTokenPath())
    } catch (error) {
      // A token file that survives a disconnect would contradict it, so only an absent file is fine.
      if (!isRecord(error) || error.code !== 'ENOENT') {
        throw error
      }
    }
  })
}

export function inAccountOrder<T>(run: () => Promise<T>): Promise<T> {
  return inCredentialFileOrder(`${getAccountFilePath()}.registry`, run)
}
