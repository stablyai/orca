import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneViewer,
  PlaneWorkspace,
  PlaneWorkspaceSelection
} from '../../shared/plane-types'
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
  PlaneApiError,
  buildQuery,
  planeRequest,
  requestWithCredentials,
  workspacePath,
  type PlaneClientForWorkspace
} from './authenticated-request'
import {
  buildPlaneWorkspace,
  normalizePlaneBaseUrl,
  planeWorkspaceToViewer,
  toPlaneViewer
} from './workspace-identity'

export function getClients(selection?: PlaneWorkspaceSelection | null): PlaneClientForWorkspace[] {
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
      // a missing token. A specific selection still rethrows so the renderer can
      // surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ workspace, apiToken: token }] : []
  })
}

export function getStatus(): PlaneConnectionStatus {
  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  const active =
    workspaces.find((workspace) => workspace.id === file.activeWorkspaceId) ?? workspaces[0] ?? null
  const credentialError = workspaces
    .map((workspace) => credentialErrors.get(workspace.id))
    .find((message) => message !== undefined)
  return {
    connected: workspaces.length > 0,
    viewer: planeWorkspaceToViewer(active),
    workspaces,
    activeWorkspaceId: active?.id ?? null,
    selectedWorkspaceId: file.selectedWorkspaceId ?? active?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  args: PlaneConnectArgs
): Promise<
  { ok: true; viewer: PlaneViewer; workspace: PlaneWorkspace } | { ok: false; error: string }
> {
  let baseUrl: string
  try {
    baseUrl = normalizePlaneBaseUrl(args.baseUrl)
  } catch {
    return { ok: false, error: 'Enter a valid Plane URL.' }
  }
  const workspaceSlug = args.workspaceSlug.trim()
  const apiToken = args.apiToken.trim()
  if (!workspaceSlug || !apiToken) {
    return { ok: false, error: 'Workspace slug and API token are required.' }
  }

  // No acquire() here: execute() takes a pool slot per request. Wrapping the
  // whole flow would hold a second slot while waiting for the first, and four
  // concurrent connects would deadlock the pool for the process lifetime.
  try {
    const viewer = toPlaneViewer(
      (await requestWithCredentials(baseUrl, apiToken, 'users/me/')) as Record<string, unknown>
    )
    // Why: /users/me/ only proves the token. Plane exposes no workspace-list
    // endpoint, so a mistyped slug would connect and then 404 on every read;
    // one cheap scoped call verifies the slug is reachable with this token.
    await requestWithCredentials(
      baseUrl,
      apiToken,
      `${workspacePath({ slug: workspaceSlug }, 'projects/')}${buildQuery({ per_page: 1 })}`
    )

    const workspace = buildPlaneWorkspace({
      baseUrl,
      slug: workspaceSlug,
      ...(args.appUrl ? { appUrl: args.appUrl } : {})
    })
    saveToken(workspace.id, apiToken)
    const file = getWorkspaceFile()
    writeWorkspaceFile({
      version: 1,
      activeWorkspaceId: workspace.id,
      selectedWorkspaceId: workspace.id,
      workspaces: [workspace, ...file.workspaces.filter((entry) => entry.id !== workspace.id)]
    })
    return { ok: true, viewer, workspace }
  } catch (error) {
    return { ok: false, error: describeConnectFailure(error, workspaceSlug) }
  }
}

export function disconnect(workspaceId?: string): void {
  const file = getWorkspaceFile()
  const ids = workspaceId ? [workspaceId] : file.workspaces.map((workspace) => workspace.id)
  for (const id of ids) {
    deleteToken(id)
  }
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: file.activeWorkspaceId,
    selectedWorkspaceId: file.selectedWorkspaceId,
    workspaces: file.workspaces.filter((workspace) => !ids.includes(workspace.id))
  })
}

export function selectWorkspace(selection: PlaneWorkspaceSelection): PlaneConnectionStatus {
  const file = getWorkspaceFile()
  if (selection !== 'all' && !file.workspaces.some((workspace) => workspace.id === selection)) {
    return getStatus()
  }
  writeWorkspaceFile({
    ...file,
    activeWorkspaceId: selection === 'all' ? file.activeWorkspaceId : selection,
    selectedWorkspaceId: selection
  })
  return getStatus()
}

export async function testConnection(
  workspaceId?: string
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  let client: PlaneClientForWorkspace | undefined
  try {
    client = getClients(workspaceId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to Plane.' }
  }
  try {
    const viewer = toPlaneViewer(
      (await planeRequest(client, 'users/me/')) as Record<string, unknown>
    )
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
}

export function clearToken(workspaceId: string): void {
  deleteToken(workspaceId)
  const file = getWorkspaceFile()
  writeWorkspaceFile({
    ...file,
    workspaces: file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  })
}

function describeConnectFailure(error: unknown, workspaceSlug: string): string {
  if (error instanceof PlaneApiError) {
    if (error.status === 401) {
      return 'Plane rejected the API token. Regenerate it in Plane under Profile settings → Personal access tokens.'
    }
    if (error.status === 403 || error.status === 404) {
      return `Workspace "${workspaceSlug}" is not reachable with this token. Check the slug in your Plane URL.`
    }
  }
  return error instanceof Error ? error.message : 'Connection failed.'
}
