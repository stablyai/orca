import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  ShortcutConnectArgs,
  ShortcutConnectionStatus,
  ShortcutViewer,
  ShortcutWorkspaceSelection
} from '../../shared/shortcut-types'
import { acquire, release } from './request-queue'
import { clearWorkspaceMetadata } from './workspace-metadata'
import {
  credentialErrors,
  deleteToken,
  getWorkspaceFile,
  hasStoredToken,
  readToken,
  saveToken,
  writeWorkspaceFile
} from './workspace-credential-store'
import {
  requestWithToken,
  ShortcutApiError,
  type ShortcutClientForWorkspace
} from './authenticated-request'
import { toShortcutWorkspace, workspaceToViewer } from './workspace-identity'

export function getClients(
  selection?: ShortcutWorkspaceSelection | null
): ShortcutClientForWorkspace[] {
  const file = getWorkspaceFile()
  const selected = selection ?? file.selectedWorkspaceId ?? file.activeWorkspaceId
  const isAllSelection = selected === 'all'
  const workspaces = isAllSelection
    ? file.workspaces
    : file.workspaces.filter((workspace) => workspace.id === (selected ?? file.activeWorkspaceId))

  return workspaces.flatMap((workspace) => {
    let token: string | null
    try {
      token = readToken(workspace.id)
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable workspace must not
      // collapse reads for the healthy ones. readToken already recorded the
      // per-workspace credentialError for getStatus to surface, so skip it like
      // a missing token. A specific-workspace selection still rethrows so the
      // renderer can surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ workspace, token }] : []
  })
}

export function getStatus(): ShortcutConnectionStatus {
  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === file.activeWorkspaceId) ?? workspaces[0] ?? null
  const credentialError = workspaces
    .map((workspace) => credentialErrors.get(workspace.id))
    .find((message) => message !== undefined)
  return {
    connected: workspaces.length > 0,
    viewer: workspaceToViewer(activeWorkspace),
    workspaces,
    activeWorkspaceId: activeWorkspace?.id ?? null,
    selectedWorkspaceId: file.selectedWorkspaceId ?? activeWorkspace?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  args: ShortcutConnectArgs
): Promise<{ ok: true; viewer: ShortcutViewer } | { ok: false; error: string }> {
  const apiToken = args.apiToken.trim()
  if (!apiToken) {
    return { ok: false, error: 'API token is required.' }
  }

  await acquire()
  try {
    const memberInfo = (await requestWithToken(apiToken, '/api/v3/member')) as Record<
      string,
      unknown
    >
    const workspace = toShortcutWorkspace(memberInfo)
    if (!workspace) {
      return { ok: false, error: 'Could not read the Shortcut workspace for this token.' }
    }
    saveToken(workspace.id, apiToken)
    const file = getWorkspaceFile()
    writeWorkspaceFile({
      version: 1,
      activeWorkspaceId: workspace.id,
      selectedWorkspaceId: workspace.id,
      workspaces: [workspace, ...file.workspaces.filter((entry) => entry.id !== workspace.id)]
    })
    return { ok: true, viewer: workspaceToViewer(workspace) as ShortcutViewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(workspaceId?: string): void {
  const file = getWorkspaceFile()
  const ids = workspaceId ? [workspaceId] : file.workspaces.map((workspace) => workspace.id)
  for (const id of ids) {
    deleteToken(id)
    clearWorkspaceMetadata(id)
  }
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: file.activeWorkspaceId,
    selectedWorkspaceId: file.selectedWorkspaceId,
    workspaces: file.workspaces.filter((workspace) => !ids.includes(workspace.id))
  })
}

export function selectWorkspace(workspaceId: ShortcutWorkspaceSelection): ShortcutConnectionStatus {
  const file = getWorkspaceFile()
  if (workspaceId !== 'all' && !file.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return getStatus()
  }
  writeWorkspaceFile({
    ...file,
    activeWorkspaceId: workspaceId === 'all' ? file.activeWorkspaceId : workspaceId,
    selectedWorkspaceId: workspaceId
  })
  return getStatus()
}

export async function testConnection(
  workspaceId?: string
): Promise<{ ok: true; viewer: ShortcutViewer } | { ok: false; error: string }> {
  let client: ShortcutClientForWorkspace | undefined
  try {
    client = getClients(workspaceId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to Shortcut.' }
  }
  await acquire()
  try {
    const memberInfo = (await requestWithToken(client.token, '/api/v3/member')) as Record<
      string,
      unknown
    >
    const workspace = toShortcutWorkspace(memberInfo)
    const viewer = workspaceToViewer(workspace ?? client.workspace)
    return viewer
      ? { ok: true, viewer }
      : { ok: false, error: 'Could not read the Shortcut member for this token.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(workspaceId: string): void {
  deleteToken(workspaceId)
  clearWorkspaceMetadata(workspaceId)
  const file = getWorkspaceFile()
  writeWorkspaceFile({
    ...file,
    workspaces: file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  })
}

export function isAuthError(error: unknown): boolean {
  // Why: Shortcut returns 403 for entitlement/permission gaps while the token
  // is still valid, so only 401 means the saved credential itself is invalid.
  return error instanceof ShortcutApiError && error.status === 401
}
