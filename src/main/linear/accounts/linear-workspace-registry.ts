import { credentialFileExists, inCredentialFileOrder } from '../../credentials/credential-file-io'
// Keep account metadata readable without decrypting tokens or triggering keychain prompts.
import { readFile, writeFile } from 'node:fs/promises'
import {
  LEGACY_WORKSPACE_ID,
  ensureOrcaDir,
  getWorkspaceFilePath,
  getWorkspaceLoginPath,
  getWorkspaceTokenPath
} from './linear-credential-paths'
import { getLegacyViewer } from './linear-legacy-viewer-store'
import {
  emptyWorkspaceFile,
  normalizeWorkspace,
  type LinearWorkspaceFile
} from './linear-workspace-record'
import type { LinearWorkspace } from '../../../shared/linear/workspace-types'
import { createIntegrationStateFileCache } from '../../credentials/integration-state-file-cache'
import { createIntegrationTokenFileCache } from '../../credentials/integration-token-file-cache'

export const workspaceTokenFileCache = createIntegrationTokenFileCache({
  service: 'Linear',
  filePath: getWorkspaceTokenPath
})
export const workspaceLoginFileCache = createIntegrationTokenFileCache({
  service: 'Linear',
  filePath: getWorkspaceLoginPath
})
const workspaceFileCache = createIntegrationStateFileCache({
  filePath: getWorkspaceFilePath,
  readFromDisk: readWorkspaceFileFromDisk
})

export function resetCredentialCaches(): void {
  workspaceTokenFileCache.clear()
  workspaceLoginFileCache.clear()
}

export async function getCredentialError(workspaceId: string): Promise<string | undefined> {
  return (
    (await workspaceTokenFileCache.error(workspaceId)) ??
    (await workspaceLoginFileCache.error(workspaceId))
  )
}

export function resetWorkspaceFileCacheToEmpty(): void {
  workspaceFileCache.invalidate()
}

async function readWorkspaceFileFromDisk(): Promise<LinearWorkspaceFile> {
  const path = getWorkspaceFilePath()
  if (!(await credentialFileExists(path))) {
    return emptyWorkspaceFile()
  }
  try {
    const raw = await readFile(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is LinearWorkspace => workspace !== null)
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

export async function getWorkspaceFile(): Promise<LinearWorkspaceFile> {
  return inCredentialFileOrder(getWorkspaceFilePath(), () => workspaceFileCache.get())
}

export async function writeWorkspaceFile(file: LinearWorkspaceFile): Promise<void> {
  return inCredentialFileOrder(getWorkspaceFilePath(), async () => {
    await ensureOrcaDir()
    const persistedWorkspaces = file.workspaces.filter(
      (workspace) => workspace.id !== LEGACY_WORKSPACE_ID
    )
    const selectableIds = new Set(persistedWorkspaces.map((workspace) => workspace.id))
    if (await hasStoredToken(LEGACY_WORKSPACE_ID)) {
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

    const next: LinearWorkspaceFile = {
      version: 1,
      activeWorkspaceId,
      selectedWorkspaceId,
      workspaces: persistedWorkspaces
    }
    await writeFile(getWorkspaceFilePath(), JSON.stringify(next, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    workspaceFileCache.invalidate()
  })
}

export async function getLegacyWorkspace(): Promise<LinearWorkspace | null> {
  if (!(await hasStoredToken(LEGACY_WORKSPACE_ID))) {
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

export async function getWorkspaceState(): Promise<LinearWorkspaceFile> {
  const file = await getWorkspaceFile()
  const legacyWorkspace = await getLegacyWorkspace()
  const presence = await Promise.all(
    file.workspaces.map((workspace) => hasStoredToken(workspace.id))
  )
  const workspaces = [
    ...(legacyWorkspace ? [legacyWorkspace] : []),
    ...file.workspaces.filter((_, index) => presence[index])
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

export async function hasStoredToken(workspaceId?: string): Promise<boolean> {
  if (!workspaceId) {
    return (await getWorkspaceState()).workspaces.length > 0
  }
  return (
    (await workspaceTokenFileCache.has(workspaceId)) ||
    (await workspaceLoginFileCache.has(workspaceId))
  )
}

// keepActive: a workspace added in the background (Connect Linear's login) leaves the active one.
export async function upsertWorkspace(
  workspace: LinearWorkspace,
  options: { select?: boolean; keepActive?: boolean } = {}
): Promise<void> {
  return inWorkspaceRegistryOrder((upsert) => upsert(workspace, options))
}

async function upsertWorkspaceInOrder(
  workspace: LinearWorkspace,
  options: { select?: boolean; keepActive?: boolean } = {}
): Promise<void> {
  const file = await getWorkspaceFile()
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
  await writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: options.keepActive ? file.activeWorkspaceId : workspace.id,
    selectedWorkspaceId: options.keepActive ? file.selectedWorkspaceId : selectedWorkspaceId,
    workspaces
  })
}

export async function resolveWorkspaceId(workspaceId?: string | null): Promise<string | null> {
  if (workspaceId && workspaceId !== 'all') {
    return workspaceId
  }
  const state = await getWorkspaceState()
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

export function inWorkspaceRegistryOrder<T>(
  run: (upsert: typeof upsertWorkspaceInOrder) => Promise<T>
): Promise<T> {
  return inCredentialFileOrder(`${getWorkspaceFilePath()}.registry`, () =>
    run(upsertWorkspaceInOrder)
  )
}
