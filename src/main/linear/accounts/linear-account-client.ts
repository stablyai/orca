import { taskProviderFailure } from '../../../shared/work-items/task-provider-failure'
import type { LinearClient } from '@linear/sdk'
import { createLinearClient, loadLinearSdk } from '../requests/linear-sdk'
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
  inWorkspaceRegistryOrder,
  getWorkspaceState,
  resolveWorkspaceId,
  upsertWorkspace,
  writeWorkspaceFile
} from './linear-workspace-registry'
import {
  clearToken,
  clearTokenFile,
  loadCredential,
  type LinearCredential,
  replaceLegacyWorkspace,
  saveWorkspaceToken,
  getWorkspaceTokenProtection
} from './linear-token-store'
import { CredentialDecryptionError } from '../../credentials/integration-credential-file'
import type {
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../../shared/linear/workspace-types'

export type LinearClientForWorkspace = {
  workspace: LinearWorkspace
  client: LinearClient
  credential: LinearCredential
}

export const LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS = 60 * 60

// User-initiated Linear actions may decrypt credentials and trigger keychain prompts.
export async function getClient(workspaceId?: string | null): Promise<LinearClient | null> {
  const resolved = await resolveWorkspaceId(workspaceId)
  const credential = resolved ? await loadCredential(resolved) : null
  return credential ? createLinearClient(credential) : null
}

export async function getClients(
  workspaceId?: LinearWorkspaceSelection | null,
  signal?: AbortSignal
): Promise<LinearClientForWorkspace[]> {
  const state = await getWorkspaceState()
  const isAllSelection = workspaceId === 'all'
  const selectedId = isAllSelection ? null : await resolveWorkspaceId(workspaceId)
  const selectedWorkspaces = isAllSelection
    ? state.workspaces
    : state.workspaces.filter((workspace) => workspace.id === selectedId)

  const clients: LinearClientForWorkspace[] = []
  for (const workspace of selectedWorkspaces) {
    let credential: LinearCredential | null
    try {
      credential = await loadCredential(workspace.id)
    } catch (error) {
      // All-workspace reads skip recorded decrypt failures; explicit selections rethrow for immediate recovery.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        continue
      }
      throw error
    }
    if (!credential) {
      continue
    }
    clients.push({
      workspace,
      client: createLinearClient({ ...credential, ...(signal ? { signal } : {}) }),
      credential
    })
  }
  return clients
}

export function getPublicFileUrlClient(
  entry: LinearClientForWorkspace,
  signal?: AbortSignal
): LinearClient {
  return createLinearClient({
    ...entry.credential,
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

    await inWorkspaceRegistryOrder(async (upsert) => {
      await saveWorkspaceToken(workspace.id, apiKey)
      const legacyWorkspace = await getLegacyWorkspace()
      if (
        legacyWorkspace &&
        legacyWorkspace.organizationName === workspace.organizationName &&
        legacyWorkspace.email === workspace.email
      ) {
        await clearTokenFile(LEGACY_WORKSPACE_ID)
        clearLegacyViewerOnDisk()
        forgetLegacyViewer()
      }
      await upsert(workspace, { select: true })
    })
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate API key'
    return { ok: false, error: message }
  }
}

export async function disconnect(workspaceId?: string): Promise<void> {
  await clearToken(workspaceId)
}

export async function selectWorkspace(
  workspaceId: LinearWorkspaceSelection
): Promise<LinearConnectionStatus> {
  const state = await getWorkspaceState()
  if (
    workspaceId !== 'all' &&
    !state.workspaces.some((workspace) => workspace.id === workspaceId)
  ) {
    return getStatus()
  }

  await inWorkspaceRegistryOrder(async () => {
    const file = await getWorkspaceFile()
    await writeWorkspaceFile({
      version: 1,
      activeWorkspaceId: workspaceId === 'all' ? file.activeWorkspaceId : workspaceId,
      selectedWorkspaceId: workspaceId,
      workspaces: file.workspaces
    })
  })
  return getStatus()
}

export async function getStatus(): Promise<LinearConnectionStatus> {
  const state = await getWorkspaceState()
  const selectedWorkspace =
    state.selectedWorkspaceId && state.selectedWorkspaceId !== 'all'
      ? state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
      : null
  const activeWorkspace =
    selectedWorkspace ??
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
    state.workspaces[0] ??
    null

  const credentialError = (
    await Promise.all(state.workspaces.map((workspace) => getCredentialError(workspace.id)))
  ).find((message) => message !== undefined)
  let credentialProtection: 'plaintext' | null = null
  for (const workspace of state.workspaces) {
    if ((await getWorkspaceTokenProtection(workspace.id)) === 'plaintext') {
      credentialProtection = 'plaintext'
      break
    }
  }

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
  const resolvedWorkspaceId = await resolveWorkspaceId(workspaceId)
  if (!resolvedWorkspaceId) {
    return taskProviderFailure('linear.noApiKey', 'No API key stored.')
  }
  let credential: LinearCredential | null
  try {
    credential = await loadCredential(resolvedWorkspaceId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
  if (!credential) {
    return taskProviderFailure('linear.noApiKey', 'No API key stored.')
  }

  try {
    const client = createLinearClient(credential)
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)
    if (!('apiKey' in credential)) {
      await upsertWorkspace(workspace, { select: true })
    } else if (resolvedWorkspaceId === LEGACY_WORKSPACE_ID) {
      await replaceLegacyWorkspace(workspace, credential.apiKey)
    } else {
      await saveWorkspaceToken(workspace.id, credential.apiKey)
      await upsertWorkspace(workspace, { select: true })
    }
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    if (isAuthError(error)) {
      await clearToken(resolvedWorkspaceId)
    }
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
}

// Warm metadata at startup without decrypting credentials or triggering keychain prompts.
export async function initLinearToken(): Promise<void> {
  await getWorkspaceFile()
  getLegacyViewer()
}
