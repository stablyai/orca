import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { ShortcutWorkspace, ShortcutWorkspaceSelection } from '../../shared/shortcut-types'

export type ShortcutWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: ShortcutWorkspaceSelection | null
  workspaces: ShortcutWorkspace[]
}

let cachedWorkspaceFile: ShortcutWorkspaceFile | null = null
let workspaceFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per workspace so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
export const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getWorkspaceFilePath(): string {
  return join(getOrcaDir(), 'shortcut-workspaces.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'shortcut-tokens')
}

function getTokenPath(workspaceId: string): string {
  return join(getTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyWorkspaceFile(): ShortcutWorkspaceFile {
  return {
    version: 1,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspaces: []
  }
}

export function hasStoredToken(workspaceId: string): boolean {
  return cachedTokens.has(workspaceId) || credentialFileHasContent(getTokenPath(workspaceId))
}

function normalizeWorkspace(input: unknown): ShortcutWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.urlSlug !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.memberId !== 'string' ||
    typeof record.memberName !== 'string' ||
    typeof record.mentionName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    urlSlug: record.urlSlug,
    name: record.name,
    memberId: record.memberId,
    memberName: record.memberName,
    mentionName: record.mentionName
  }
}

function readWorkspaceFileFromDisk(): ShortcutWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<ShortcutWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is ShortcutWorkspace => workspace !== null)
          .filter((workspace) => hasStoredToken(workspace.id))
      : []
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
    return { version: 1, activeWorkspaceId, selectedWorkspaceId, workspaces }
  } catch {
    return emptyWorkspaceFile()
  }
}

export function getWorkspaceFile(): ShortcutWorkspaceFile {
  if (!workspaceFileLoaded || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoaded = true
  }
  return cachedWorkspaceFile
}

export function writeWorkspaceFile(file: ShortcutWorkspaceFile): void {
  const orcaDir = getOrcaDir()
  if (!existsSync(orcaDir)) {
    mkdirSync(orcaDir, { recursive: true })
  }
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  const activeWorkspaceId =
    file.activeWorkspaceId &&
    workspaces.some((workspace) => workspace.id === file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : (workspaces[0]?.id ?? null)
  const selectedWorkspaceId =
    file.selectedWorkspaceId === 'all'
      ? 'all'
      : file.selectedWorkspaceId &&
          workspaces.some((workspace) => workspace.id === file.selectedWorkspaceId)
        ? file.selectedWorkspaceId
        : activeWorkspaceId

  const nextFile: ShortcutWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  }
  // Why: a crash mid-write would leave invalid JSON, dropping every stored
  // connection while the token files stay orphaned; rename keeps it all-or-nothing.
  // The cache updates only after the write lands so a failed persist never
  // leaves this process reading state that disappears on restart.
  writeCredentialFileAtomic(
    getWorkspaceFilePath(),
    Buffer.from(JSON.stringify(nextFile, null, 2), 'utf-8')
  )
  cachedWorkspaceFile = nextFile
  workspaceFileLoaded = true
}

export function readToken(workspaceId: string): string | null {
  const cached = cachedTokens.get(workspaceId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(workspaceId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('Shortcut', raw)
    if (token) {
      cachedTokens.set(workspaceId, token)
    }
    credentialErrors.delete(workspaceId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(workspaceId, error.message)
      throw error
    }
    return null
  }
}

export function saveToken(workspaceId: string, apiToken: string): void {
  ensureTokenDir()
  writeEncryptedCredential('Shortcut', getTokenPath(workspaceId), apiToken)
  cachedTokens.set(workspaceId, apiToken)
  credentialErrors.delete(workspaceId)
}

export function deleteToken(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  credentialErrors.delete(workspaceId)
  try {
    unlinkSync(getTokenPath(workspaceId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}
