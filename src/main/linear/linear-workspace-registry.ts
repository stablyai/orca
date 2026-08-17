// ── Token + workspace storage ────────────────────────────────────────
// Why: tokens remain encrypted via safeStorage, while workspace metadata stays
// plaintext so status checks can render connected accounts without decrypting
// and triggering OS keychain prompts after app updates.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  LEGACY_WORKSPACE_ID,
  ensureOrcaDir,
  getWorkspaceFilePath,
  getWorkspaceTokenPath
} from './linear-credential-paths'
import { getLegacyViewer } from './linear-legacy-viewer-store'
import {
  emptyWorkspaceFile,
  normalizeWorkspace,
  type LinearWorkspaceFile
} from './linear-workspace-record'
import { credentialFileHasContent } from '../integration-credential-file'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'

let cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per workspace so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()
let cachedWorkspaceFile: LinearWorkspaceFile | null = null
let workspaceFileLoadedFromDisk = false

export function getCachedToken(workspaceId: string): string | undefined {
  return cachedTokens.get(workspaceId)
}

export function cacheToken(workspaceId: string, token: string): void {
  cachedTokens.set(workspaceId, token)
}

export function forgetCachedToken(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  credentialErrors.delete(workspaceId)
}

export function resetCredentialCaches(): void {
  cachedTokens = new Map()
  credentialErrors.clear()
}

export function recordCredentialError(workspaceId: string, message: string): void {
  credentialErrors.set(workspaceId, message)
}

export function clearCredentialError(workspaceId: string): void {
  credentialErrors.delete(workspaceId)
}

export function getCredentialError(workspaceId: string): string | undefined {
  return credentialErrors.get(workspaceId)
}

export function resetWorkspaceFileCacheToEmpty(): void {
  cachedWorkspaceFile = emptyWorkspaceFile()
  workspaceFileLoadedFromDisk = true
}

function readWorkspaceFileFromDisk(): LinearWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is LinearWorkspace => workspace !== null)
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

    return {
      version: 1,
      activeWorkspaceId,
      selectedWorkspaceId,
      workspaces
    }
  } catch {
    return emptyWorkspaceFile()
  }
}

export function getWorkspaceFile(): LinearWorkspaceFile {
  if (!workspaceFileLoadedFromDisk || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoadedFromDisk = true
  }
  return cachedWorkspaceFile
}

export function writeWorkspaceFile(file: LinearWorkspaceFile): void {
  ensureOrcaDir()
  const persistedWorkspaces = file.workspaces.filter(
    (workspace) => workspace.id !== LEGACY_WORKSPACE_ID
  )
  const selectableIds = new Set(persistedWorkspaces.map((workspace) => workspace.id))
  if (hasStoredToken(LEGACY_WORKSPACE_ID)) {
    selectableIds.add(LEGACY_WORKSPACE_ID)
  }
  const activeWorkspaceId =
    file.activeWorkspaceId && selectableIds.has(file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : (persistedWorkspaces[0]?.id ??
        (selectableIds.has(LEGACY_WORKSPACE_ID) ? LEGACY_WORKSPACE_ID : null))
  const selectedWorkspaceId =
    file.selectedWorkspaceId === 'all'
      ? 'all'
      : file.selectedWorkspaceId && selectableIds.has(file.selectedWorkspaceId)
        ? file.selectedWorkspaceId
        : activeWorkspaceId

  cachedWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces: persistedWorkspaces
  }
  workspaceFileLoadedFromDisk = true
  writeFileSync(getWorkspaceFilePath(), JSON.stringify(cachedWorkspaceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

export function getLegacyWorkspace(): LinearWorkspace | null {
  if (!hasStoredToken(LEGACY_WORKSPACE_ID)) {
    return null
  }
  const viewer = getLegacyViewer()
  return {
    id: LEGACY_WORKSPACE_ID,
    organizationId: viewer?.organizationId ?? LEGACY_WORKSPACE_ID,
    organizationName: viewer?.organizationName ?? 'Saved Linear workspace',
    organizationUrlKey: viewer?.organizationUrlKey,
    displayName: viewer?.displayName ?? 'Linear API key',
    email: viewer?.email ?? null,
    isLegacy: true
  }
}

export function getWorkspaceState(): LinearWorkspaceFile {
  const file = getWorkspaceFile()
  const legacyWorkspace = getLegacyWorkspace()
  const workspaces = [
    ...(legacyWorkspace ? [legacyWorkspace] : []),
    ...file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  ]
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

  return {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  }
}

export function hasStoredToken(workspaceId?: string): boolean {
  if (!workspaceId) {
    return getWorkspaceState().workspaces.length > 0
  }
  if (cachedTokens.has(workspaceId)) {
    return true
  }
  return credentialFileHasContent(getWorkspaceTokenPath(workspaceId))
}

export function upsertWorkspace(
  workspace: LinearWorkspace,
  options: { select?: boolean } = {}
): void {
  const file = getWorkspaceFile()
  const current = file.workspaces.find((entry) => entry.id === workspace.id)
  const credentialRevision = (current?.credentialRevision ?? 0) + 1
  const workspaceWithRevision = { ...workspace, credentialRevision }
  const withoutCurrent = file.workspaces.filter((entry) => entry.id !== workspace.id)
  const workspaces = [...withoutCurrent, workspaceWithRevision].sort((a, b) =>
    a.organizationName.localeCompare(b.organizationName)
  )
  const selectedWorkspaceId = options.select
    ? workspace.id
    : file.selectedWorkspaceId && file.selectedWorkspaceId !== LEGACY_WORKSPACE_ID
      ? file.selectedWorkspaceId
      : workspace.id
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: workspace.id,
    selectedWorkspaceId,
    workspaces
  })
}

export function resolveWorkspaceId(workspaceId?: string | null): string | null {
  if (workspaceId && workspaceId !== 'all') {
    return workspaceId
  }
  const state = getWorkspaceState()
  if (
    state.selectedWorkspaceId &&
    state.selectedWorkspaceId !== 'all' &&
    state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)
  ) {
    return state.selectedWorkspaceId
  }
  if (
    state.activeWorkspaceId &&
    state.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
  ) {
    return state.activeWorkspaceId
  }
  return state.workspaces[0]?.id ?? null
}
