import type {
  AsanaConnectArgs,
  AsanaConnectionStatus,
  AsanaViewer,
  AsanaWorkspace,
  AsanaWorkspaceSelection
} from '../../shared/types'
import { acquire, release } from './asana-concurrency'
import {
  AsanaApiError,
  asanaRequest,
  authHeader,
  requestWithToken,
  type AsanaClientForWorkspace,
  type AsanaMeResponse
} from './asana-request'
import {
  deleteToken,
  getWorkspaceFile,
  hasStoredToken,
  readToken,
  saveToken,
  writeWorkspaceFile
} from './asana-credential-store'

// Re-export the surface the query/mutation layer (issues.ts) still imports from
// this module, keeping the credential/request internals split into focused files.
export { acquire, release } from './asana-concurrency'
export {
  ASANA_API_BASE,
  AsanaApiError,
  asanaRequest,
  type AsanaClientForWorkspace
} from './asana-request'

// Why: Asana exposes no API to detect a workspace's plan tier — the premium
// search endpoint must be probed and returns 402 on free tiers. Remember that
// once per workspace so repeat searches skip the doomed call and go straight to
// the local-filter fallback. Reset whenever connection state changes.
const searchUnavailableWorkspaces = new Set<string>()

export function markSearchUnavailable(workspaceId: string): void {
  searchUnavailableWorkspaces.add(workspaceId)
}

export function isSearchUnavailable(workspaceId: string): boolean {
  return searchUnavailableWorkspaces.has(workspaceId)
}

function workspaceToViewer(workspace: AsanaWorkspace | null): AsanaViewer | null {
  if (!workspace) {
    return null
  }
  return {
    gid: workspace.userGid,
    name: workspace.userName,
    email: workspace.userEmail
  }
}

export function getClients(selection?: AsanaWorkspaceSelection | null): AsanaClientForWorkspace[] {
  const file = getWorkspaceFile()
  const selected = selection ?? file.selectedWorkspaceId ?? file.activeWorkspaceId
  const workspaces =
    selected === 'all'
      ? file.workspaces
      : file.workspaces.filter((workspace) => workspace.id === (selected ?? file.activeWorkspaceId))

  return workspaces.flatMap((workspace) => {
    const token = readToken(workspace.id)
    return token ? [{ workspace, authorization: authHeader(token) }] : []
  })
}

export function getStatus(): AsanaConnectionStatus {
  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === file.activeWorkspaceId) ?? workspaces[0] ?? null
  return {
    connected: workspaces.length > 0,
    viewer: workspaceToViewer(activeWorkspace),
    workspaces,
    activeWorkspaceId: activeWorkspace?.id ?? null,
    selectedWorkspaceId: file.selectedWorkspaceId ?? activeWorkspace?.id ?? null
  }
}

function toWorkspaces(me: AsanaMeResponse['data']): AsanaWorkspace[] {
  const userGid = typeof me?.gid === 'string' ? me.gid : ''
  const userName = typeof me?.name === 'string' ? me.name : 'Asana user'
  const userEmail = typeof me?.email === 'string' ? me.email : null
  const workspaces = Array.isArray(me?.workspaces) ? me.workspaces : []
  return workspaces
    .filter(
      (workspace): workspace is { gid: string; name?: string } => typeof workspace?.gid === 'string'
    )
    .map((workspace) => ({
      id: workspace.gid,
      name: typeof workspace.name === 'string' ? workspace.name : 'Workspace',
      userGid,
      userName,
      userEmail
    }))
}

export async function connect(
  args: AsanaConnectArgs
): Promise<{ ok: true; viewer: AsanaViewer } | { ok: false; error: string }> {
  const apiToken = args.apiToken.trim()
  if (!apiToken) {
    return { ok: false, error: 'A Personal Access Token is required.' }
  }

  await acquire()
  try {
    const response = (await requestWithToken(
      apiToken,
      '/users/me?opt_fields=name,email,workspaces.name'
    )) as AsanaMeResponse
    const workspaces = toWorkspaces(response.data)
    if (workspaces.length === 0) {
      return { ok: false, error: 'This token has no accessible Asana workspaces.' }
    }
    // Why: a single PAT authenticates every workspace, so we persist the same
    // token under each workspace id to keep the per-workspace selection model
    // identical to Jira's per-site storage.
    for (const workspace of workspaces) {
      saveToken(workspace.id, apiToken)
    }
    // Why: a new PAT may belong to a different plan tier, so forget any prior
    // "search unavailable" verdict and let the next search re-probe.
    searchUnavailableWorkspaces.clear()
    const file = getWorkspaceFile()
    const newIds = new Set(workspaces.map((workspace) => workspace.id))
    writeWorkspaceFile({
      version: 1,
      activeWorkspaceId: workspaces[0].id,
      selectedWorkspaceId: workspaces[0].id,
      workspaces: [...workspaces, ...file.workspaces.filter((entry) => !newIds.has(entry.id))]
    })
    return { ok: true, viewer: workspaceToViewer(workspaces[0])! }
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
    searchUnavailableWorkspaces.delete(id)
  }
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: file.activeWorkspaceId,
    selectedWorkspaceId: file.selectedWorkspaceId,
    workspaces: file.workspaces.filter((workspace) => !ids.includes(workspace.id))
  })
}

export function selectWorkspace(workspaceId: AsanaWorkspaceSelection): AsanaConnectionStatus {
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
): Promise<{ ok: true; viewer: AsanaViewer } | { ok: false; error: string }> {
  const client = getClients(workspaceId)[0]
  if (!client) {
    return { ok: false, error: 'Not connected to Asana.' }
  }
  await acquire()
  try {
    const response = (await asanaRequest(
      client,
      '/users/me?opt_fields=name,email'
    )) as AsanaMeResponse
    return {
      ok: true,
      viewer: {
        gid: typeof response.data?.gid === 'string' ? response.data.gid : client.workspace.userGid,
        name:
          typeof response.data?.name === 'string' ? response.data.name : client.workspace.userName,
        email:
          typeof response.data?.email === 'string'
            ? response.data.email
            : client.workspace.userEmail
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(workspaceId: string): void {
  deleteToken(workspaceId)
  searchUnavailableWorkspaces.delete(workspaceId)
  const file = getWorkspaceFile()
  writeWorkspaceFile({
    ...file,
    workspaces: file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  })
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AsanaApiError && (error.status === 401 || error.status === 403)
}
