import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { safeStorage } from 'electron'
import type { AsanaWorkspace, AsanaWorkspaceSelection } from '../../shared/types'

type AsanaWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: AsanaWorkspaceSelection | null
  workspaces: AsanaWorkspace[]
}

let cachedWorkspaceFile: AsanaWorkspaceFile | null = null
let workspaceFileLoaded = false
const cachedTokens = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getWorkspaceFilePath(): string {
  return join(getOrcaDir(), 'asana-workspaces.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'asana-tokens')
}

function getTokenPath(workspaceId: string): string {
  return join(getTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
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

function emptyWorkspaceFile(): AsanaWorkspaceFile {
  return {
    version: 1,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspaces: []
  }
}

export function hasStoredToken(workspaceId: string): boolean {
  return cachedTokens.has(workspaceId) || existsSync(getTokenPath(workspaceId))
}

function normalizeWorkspace(input: unknown): AsanaWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.userGid !== 'string' ||
    typeof record.userName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    userGid: record.userGid,
    userName: record.userName,
    userEmail: typeof record.userEmail === 'string' ? record.userEmail : null
  }
}

function readWorkspaceFileFromDisk(): AsanaWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<AsanaWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is AsanaWorkspace => workspace !== null)
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

export function getWorkspaceFile(): AsanaWorkspaceFile {
  if (!workspaceFileLoaded || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoaded = true
  }
  return cachedWorkspaceFile
}

export function writeWorkspaceFile(file: AsanaWorkspaceFile): void {
  ensureOrcaDir()
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

  cachedWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  }
  workspaceFileLoaded = true
  writeFileSync(getWorkspaceFilePath(), JSON.stringify(cachedWorkspaceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

// Why: persist the on-disk format alongside the bytes so reads don't depend on
// the *current* safeStorage availability. If that flips between write and read,
// a marker-less heuristic would decrypt plaintext as garbage (or vice versa).
const TOKEN_ENC_PREFIX = 'asana-token:v1:enc\n'
const TOKEN_PLAIN_PREFIX = 'asana-token:v1:plain\n'

function writeEncryptedToken(path: string, apiToken: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiToken)
    writeFileSync(path, Buffer.concat([Buffer.from(TOKEN_ENC_PREFIX), encrypted]), { mode: 0o600 })
    return
  }
  console.warn('[asana] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, `${TOKEN_PLAIN_PREFIX}${apiToken}`, { encoding: 'utf-8', mode: 0o600 })
}

function decodeStoredToken(raw: Buffer): string | null {
  const header = raw.subarray(0, 32).toString('utf-8')
  if (header.startsWith(TOKEN_ENC_PREFIX)) {
    // Encrypted on disk but no key available now — credentials are unreadable.
    if (!safeStorage.isEncryptionAvailable()) {
      return null
    }
    return safeStorage.decryptString(raw.subarray(Buffer.byteLength(TOKEN_ENC_PREFIX)))
  }
  if (header.startsWith(TOKEN_PLAIN_PREFIX)) {
    return raw.subarray(Buffer.byteLength(TOKEN_PLAIN_PREFIX)).toString('utf-8')
  }
  // Legacy token without a format marker — fall back to the prior heuristic.
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(raw)
    : raw.toString('utf-8')
}

export function readToken(workspaceId: string): string | null {
  const cached = cachedTokens.get(workspaceId)
  if (cached) {
    return cached
  }
  const path = getTokenPath(workspaceId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = decodeStoredToken(readFileSync(path))
    if (token === null) {
      return null
    }
    cachedTokens.set(workspaceId, token)
    return token
  } catch {
    return null
  }
}

export function saveToken(workspaceId: string, apiToken: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(workspaceId), apiToken)
  cachedTokens.set(workspaceId, apiToken)
}

export function deleteToken(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  try {
    unlinkSync(getTokenPath(workspaceId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}
