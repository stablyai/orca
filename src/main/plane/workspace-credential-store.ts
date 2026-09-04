import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type { PlaneWorkspace, PlaneWorkspaceSelection } from '../../shared/plane-types'

export type PlaneWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: PlaneWorkspaceSelection | null
  workspaces: PlaneWorkspace[]
}

let cachedWorkspaceFile: PlaneWorkspaceFile | null = null
let workspaceFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per workspace so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
export const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getWorkspaceFilePath(): string {
  return join(getOrcaDir(), 'plane-workspaces.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'plane-tokens')
}

function getTokenPath(workspaceId: string): string {
  return join(getTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyWorkspaceFile(): PlaneWorkspaceFile {
  return { version: 1, activeWorkspaceId: null, selectedWorkspaceId: null, workspaces: [] }
}

export function hasStoredToken(workspaceId: string): boolean {
  return cachedTokens.has(workspaceId) || credentialFileHasContent(getTokenPath(workspaceId))
}

function normalizeWorkspace(input: unknown): PlaneWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.slug !== 'string' ||
    typeof record.baseUrl !== 'string' ||
    typeof record.appUrl !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    slug: record.slug,
    name: typeof record.name === 'string' && record.name ? record.name : record.slug,
    baseUrl: record.baseUrl,
    appUrl: record.appUrl,
    // Workspaces saved before the deployment field existed are Cloud.
    deployment: record.deployment === 'self-hosted' ? 'self-hosted' : 'cloud'
  }
}

function readWorkspaceFileFromDisk(): PlaneWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<PlaneWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is PlaneWorkspace => workspace !== null)
          .filter((workspace) => hasStoredToken(workspace.id))
      : []
    return {
      version: 1,
      ...resolveSelection(workspaces, parsed.activeWorkspaceId, parsed.selectedWorkspaceId),
      workspaces
    }
  } catch {
    return emptyWorkspaceFile()
  }
}

function resolveSelection(
  workspaces: readonly PlaneWorkspace[],
  activeCandidate: unknown,
  selectedCandidate: unknown
): { activeWorkspaceId: string | null; selectedWorkspaceId: PlaneWorkspaceSelection | null } {
  const has = (id: unknown): boolean =>
    typeof id === 'string' && workspaces.some((workspace) => workspace.id === id)
  const activeWorkspaceId = has(activeCandidate)
    ? (activeCandidate as string)
    : (workspaces[0]?.id ?? null)
  const selectedWorkspaceId =
    selectedCandidate === 'all'
      ? 'all'
      : has(selectedCandidate)
        ? (selectedCandidate as string)
        : activeWorkspaceId
  return { activeWorkspaceId, selectedWorkspaceId }
}

export function getWorkspaceFile(): PlaneWorkspaceFile {
  if (!workspaceFileLoaded || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoaded = true
  }
  return cachedWorkspaceFile
}

export function writeWorkspaceFile(file: PlaneWorkspaceFile): void {
  ensureDir(getOrcaDir())
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  cachedWorkspaceFile = {
    version: 1,
    ...resolveSelection(workspaces, file.activeWorkspaceId, file.selectedWorkspaceId),
    workspaces
  }
  workspaceFileLoaded = true
  writeFileSync(getWorkspaceFilePath(), JSON.stringify(cachedWorkspaceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
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
    const token = readStoredCredentialToken('Plane', readFileSync(path))
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
  ensureDir(getOrcaDir())
  ensureDir(getTokenDir())
  writeEncryptedCredential('Plane', getTokenPath(workspaceId), apiToken)
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

/** Test seam: drops every in-process cache so a fresh disk read happens. */
export function resetPlaneCredentialCaches(): void {
  cachedWorkspaceFile = null
  workspaceFileLoaded = false
  cachedTokens.clear()
  credentialErrors.clear()
}
