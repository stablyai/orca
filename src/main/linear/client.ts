import { taskProviderFailure } from '../../shared/task-provider-failure'
import type { LinearClient } from '@linear/sdk'
import { createLinearClient, loadLinearSdk } from './linear-sdk'
import { LEGACY_WORKSPACE_ID } from './linear-credential-paths'
import {
  clearLegacyViewerOnDisk,
  forgetLegacyViewer,
  getLegacyViewer
} from './linear-legacy-viewer-store'
import { workspaceFromLinearData } from './linear-workspace-record'
import {
  getCredentialError,
  getLegacyWorkspace,
  getWorkspaceFile,
  getWorkspaceState,
  resolveWorkspaceId,
  upsertWorkspace,
  writeWorkspaceFile
} from './linear-workspace-registry'
import {
  clearToken,
  clearTokenFile,
  loadToken,
  replaceLegacyWorkspace,
  saveWorkspaceToken,
  getWorkspaceTokenProtection
} from './linear-token-store'
import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'

export type LinearClientForWorkspace = {
  workspace: LinearWorkspace
  client: LinearClient
  apiKey: string
}

export const LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS = 60 * 60

// User-initiated Linear actions may decrypt credentials and trigger keychain prompts.
export function getClient(workspaceId?: string | null): LinearClient | null {
  const token = loadToken({
    force: true,
    workspaceId: resolveWorkspaceId(workspaceId) ?? undefined
  })
  if (!token) {
    return null
  }
  return createLinearClient({ apiKey: token })
}

export function getClients(
  workspaceId?: LinearWorkspaceSelection | null,
  signal?: AbortSignal
): LinearClientForWorkspace[] {
  const state = getWorkspaceState()
  const isAllSelection = workspaceId === 'all'
  const selectedWorkspaces = isAllSelection
    ? state.workspaces
    : state.workspaces.filter((workspace) => workspace.id === resolveWorkspaceId(workspaceId))

  const clients: LinearClientForWorkspace[] = []
  for (const workspace of selectedWorkspaces) {
    let token: string | null
    try {
      token = loadToken({ force: true, workspaceId: workspace.id })
    } catch (error) {
      // All-workspace reads skip recorded decrypt failures; explicit selections rethrow for immediate recovery.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        continue
      }
      throw error
    }
    if (!token) {
      continue
    }
    clients.push({
      workspace,
      client: createLinearClient({ apiKey: token, ...(signal ? { signal } : {}) }),
      apiKey: token
    })
  }
  return clients
}

export function getPublicFileUrlClient(
  entry: LinearClientForWorkspace,
  signal?: AbortSignal
): LinearClient {
  return createLinearClient({
    apiKey: entry.apiKey,
    ...(signal ? { signal } : {}),
    headers: {
      'public-file-urls-expire-in': String(LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS)
    }
  })
}

export function isAuthError(error: unknown): boolean {
  return error instanceof loadLinearSdk().AuthenticationLinearError
}

export async function connect(
  apiKey: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  try {
    const client = createLinearClient({ apiKey })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)

    saveWorkspaceToken(workspace.id, apiKey)
    const legacyWorkspace = getLegacyWorkspace()
    if (
      legacyWorkspace &&
      legacyWorkspace.organizationName === workspace.organizationName &&
      legacyWorkspace.email === workspace.email
    ) {
      clearTokenFile(LEGACY_WORKSPACE_ID)
      clearLegacyViewerOnDisk()
      forgetLegacyViewer()
    }
    upsertWorkspace(workspace, { select: true })
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate API key'
    return { ok: false, error: message }
  }
}

export function disconnect(workspaceId?: string): void {
  clearToken(workspaceId)
}

export function selectWorkspace(workspaceId: LinearWorkspaceSelection): LinearConnectionStatus {
  const state = getWorkspaceState()
  if (
    workspaceId !== 'all' &&
    !state.workspaces.some((workspace) => workspace.id === workspaceId)
  ) {
    return getStatus()
  }

  const file = getWorkspaceFile()
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: workspaceId === 'all' ? file.activeWorkspaceId : workspaceId,
    selectedWorkspaceId: workspaceId,
    workspaces: file.workspaces
  })
  return getStatus()
}

export function getStatus(): LinearConnectionStatus {
  const state = getWorkspaceState()
  const selectedWorkspace =
    state.selectedWorkspaceId && state.selectedWorkspaceId !== 'all'
      ? state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
      : null
  const activeWorkspace =
    selectedWorkspace ??
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
    state.workspaces[0] ??
    null

  const credentialError = state.workspaces
    .map((workspace) => getCredentialError(workspace.id))
    .find((message) => message !== undefined)
  // Host-wide protection must report any plaintext workspace, even when the active one is sealed.
  const credentialProtection = state.workspaces.some(
    (workspace) => getWorkspaceTokenProtection(workspace.id) === 'plaintext'
  )
    ? 'plaintext'
    : null

  return {
    connected: state.workspaces.length > 0,
    viewer: activeWorkspace,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    ...(credentialError ? { credentialError } : {}),
    credentialProtection
  }
}

export async function testConnection(
  workspaceId?: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  const resolvedWorkspaceId = resolveWorkspaceId(workspaceId)
  if (!resolvedWorkspaceId) {
    return taskProviderFailure('linear.noApiKey', 'No API key stored.')
  }
  let token: string | null
  try {
    token = loadToken({ force: true, workspaceId: resolvedWorkspaceId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
  if (!token) {
    return taskProviderFailure('linear.noApiKey', 'No API key stored.')
  }

  try {
    const client = createLinearClient({ apiKey: token })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)
    if (resolvedWorkspaceId === LEGACY_WORKSPACE_ID) {
      replaceLegacyWorkspace(workspace, token)
    } else {
      saveWorkspaceToken(workspace.id, token)
      upsertWorkspace(workspace, { select: true })
    }
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(resolvedWorkspaceId)
    }
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
}

// Warm metadata at startup without decrypting credentials or triggering keychain prompts.
export function initLinearToken(): void {
  getWorkspaceFile()
  getLegacyViewer()
}
