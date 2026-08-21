import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { ClickUpViewer, ClickUpWorkspace, ClickUpWorkspaceSelection } from '../../shared/clickup-types'
export type ClickUpAccountFile = {
  version: 1
  viewer: ClickUpViewer
  workspaces: ClickUpWorkspace[]
  activeWorkspaceId: string | null
  selectedWorkspaceId: ClickUpWorkspaceSelection | null
}

let cachedToken: string | null | undefined
let cachedAccountFile: ClickUpAccountFile | null = null
let accountFileLoaded = false
let credentialError: string | undefined

function orcaDirectory(): string {
  return join(homedir(), '.orca')
}

function tokenPath(): string {
  return join(orcaDirectory(), 'clickup-token.enc')
}

function accountPath(): string {
  return join(orcaDirectory(), 'clickup-account.json')
}

function ensureOrcaDirectory(): void {
  const directory = orcaDirectory()
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
}

export function normalizeClickUpViewer(value: unknown): ClickUpViewer | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'number' || typeof record.username !== 'string') {
    return null
  }
  return {
    id: record.id,
    username: record.username,
    email: typeof record.email === 'string' ? record.email : null,
    color: typeof record.color === 'string' ? record.color : undefined,
    profilePicture: typeof record.profilePicture === 'string' ? record.profilePicture : undefined
  }
}

export function normalizeClickUpWorkspace(value: unknown): ClickUpWorkspace | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    (typeof record.id !== 'string' && typeof record.id !== 'number') ||
    typeof record.name !== 'string'
  ) {
    return null
  }
  const members = Array.isArray(record.members) ? record.members : undefined
  return {
    id: String(record.id),
    name: record.name,
    color: typeof record.color === 'string' ? record.color : undefined,
    avatar: typeof record.avatar === 'string' ? record.avatar : undefined,
    memberCount: members?.length
  }
}

export function readClickUpAccount(): ClickUpAccountFile | null {
  if (accountFileLoaded) {
    return cachedAccountFile
  }
  accountFileLoaded = true
  if (!existsSync(accountPath())) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(accountPath(), 'utf8')) as Partial<ClickUpAccountFile>
    const viewer = normalizeClickUpViewer(parsed.viewer)
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map(normalizeClickUpWorkspace)
          .filter((workspace): workspace is ClickUpWorkspace => workspace !== null)
      : []
    if (!viewer || workspaces.length === 0) {
      return null
    }
    const activeWorkspaceId =
      typeof parsed.activeWorkspaceId === 'string' &&
      workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : (workspaces[0]?.id ?? null)
    const selectedWorkspaceId =
      parsed.selectedWorkspaceId === 'all' ||
      (typeof parsed.selectedWorkspaceId === 'string' &&
        workspaces.some((workspace) => workspace.id === parsed.selectedWorkspaceId))
        ? parsed.selectedWorkspaceId
        : activeWorkspaceId
    cachedAccountFile = {
      version: 1,
      viewer,
      workspaces,
      activeWorkspaceId,
      selectedWorkspaceId
    }
    return cachedAccountFile
  } catch {
    return null
  }
}

export function writeClickUpAccount(file: ClickUpAccountFile): void {
  ensureOrcaDirectory()
  cachedAccountFile = file
  accountFileLoaded = true
  writeFileSync(accountPath(), JSON.stringify(file, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
}

export function readClickUpToken(): string | null {
  if (cachedToken !== undefined) {
    return cachedToken
  }
  if (!existsSync(tokenPath())) {
    cachedToken = null
    return null
  }
  try {
    cachedToken = readStoredCredentialToken('ClickUp', readFileSync(tokenPath()))
    credentialError = undefined
    return cachedToken
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
      throw error
    }
    cachedToken = null
    return null
  }
}

export function saveClickUpToken(token: string): void {
  ensureOrcaDirectory()
  // Why: the shared writer publishes through a temp file + fsync + rename, so a
  // failed or interrupted write cannot truncate the saved credential (STA-3941),
  // and it re-applies 0600 to an already-existing file.
  writeEncryptedCredential('ClickUp', tokenPath(), token)
  cachedToken = token
  credentialError = undefined
}

export function hasStoredClickUpToken(): boolean {
  return credentialFileHasContent(tokenPath())
}

export function getClickUpCredentialError(): string | undefined {
  return credentialError
}

export function deleteStoredClickUpConnection(): void {
  cachedToken = null
  cachedAccountFile = null
  accountFileLoaded = true
  credentialError = undefined
  for (const path of [tokenPath(), accountPath()]) {
    try {
      unlinkSync(path)
    } catch {
      // A partially configured connection may not have both files.
    }
  }
}
