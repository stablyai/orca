import type {
  ClickUpConnectionStatus,
  ClickUpViewer,
  ClickUpWorkspace,
  ClickUpWorkspaceSelection
} from '../../shared/clickup-types'
import {
  deleteStoredClickUpConnection,
  getClickUpCredentialError,
  hasStoredClickUpToken,
  normalizeClickUpViewer,
  normalizeClickUpWorkspace,
  readClickUpAccount,
  readClickUpToken,
  saveClickUpToken,
  writeClickUpAccount
} from './connection-storage'
import {
  acquire,
  ClickUpApiError,
  release,
  requestWithToken,
  type ClickUpClientForWorkspace
} from './request'

export { ClickUpApiError, clickUpRequest, type ClickUpClientForWorkspace } from './request'

export function getClients(
  selection?: ClickUpWorkspaceSelection | null
): ClickUpClientForWorkspace[] {
  const account = readClickUpAccount()
  if (!account) {
    return []
  }
  let token: string | null
  try {
    token = readClickUpToken()
  } catch {
    // Why: credentials copied from another OS profile should behave as disconnected, not crash task reads.
    return []
  }
  if (!token) {
    return []
  }
  const selected = selection ?? account.selectedWorkspaceId ?? account.activeWorkspaceId
  const workspaces =
    selected === 'all'
      ? account.workspaces
      : account.workspaces.filter((workspace) => workspace.id === selected)
  return workspaces.map((workspace) => ({ workspace, token }))
}

export function requireClickUpClient(workspaceId?: string): ClickUpClientForWorkspace {
  const client = getClients(workspaceId)[0]
  if (!client) {
    throw new Error('Connect ClickUp and select a Workspace first.')
  }
  return client
}

export function requireClickUpClients(
  workspaceId?: ClickUpWorkspaceSelection | null
): ClickUpClientForWorkspace[] {
  const clients = getClients(workspaceId)
  if (clients.length === 0) {
    throw new Error('Connect ClickUp and select a Workspace first.')
  }
  return clients
}

export function getStatus(): ClickUpConnectionStatus {
  const hasToken = hasStoredClickUpToken()
  const account = readClickUpAccount()
  const credentialError = getClickUpCredentialError()
  if (!hasToken || !account) {
    return {
      connected: false,
      viewer: null,
      ...(credentialError ? { credentialError } : {})
    }
  }
  return {
    connected: true,
    viewer: account.viewer,
    workspaces: account.workspaces,
    activeWorkspaceId: account.activeWorkspaceId,
    selectedWorkspaceId: account.selectedWorkspaceId,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  apiToken: string
): Promise<{ ok: true; viewer: ClickUpViewer } | { ok: false; error: string }> {
  const token = apiToken.trim()
  if (!token) {
    return { ok: false, error: 'Personal API token is required.' }
  }
  await acquire()
  try {
    const [userResponse, workspaceResponse] = await Promise.all([
      requestWithToken<{ user?: unknown }>(token, '/user'),
      requestWithToken<{ teams?: unknown[] }>(token, '/team')
    ])
    const viewer = normalizeClickUpViewer(userResponse.user)
    const workspaces = (workspaceResponse.teams ?? [])
      .map(normalizeClickUpWorkspace)
      .filter((workspace): workspace is ClickUpWorkspace => workspace !== null)
    if (!viewer) {
      return { ok: false, error: 'ClickUp returned an invalid user profile.' }
    }
    if (workspaces.length === 0) {
      return { ok: false, error: 'No ClickUp Workspaces are available for this token.' }
    }
    saveClickUpToken(token)
    writeClickUpAccount({
      version: 1,
      viewer,
      workspaces,
      activeWorkspaceId: workspaces[0]!.id,
      selectedWorkspaceId: workspaces[0]!.id
    })
    return { ok: true, viewer }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not connect to ClickUp.'
    }
  } finally {
    release()
  }
}

// Why: response caches (List hierarchy, search pages) register here so a
// disconnect drops data the old token could see.
const disconnectListeners = new Set<() => void>()

export function onClickUpDisconnect(listener: () => void): void {
  disconnectListeners.add(listener)
}

export function disconnect(): void {
  deleteStoredClickUpConnection()
  for (const listener of disconnectListeners) {
    listener()
  }
}

export function selectWorkspace(workspaceId: ClickUpWorkspaceSelection): ClickUpConnectionStatus {
  const account = readClickUpAccount()
  if (
    !account ||
    (workspaceId !== 'all' && !account.workspaces.some((workspace) => workspace.id === workspaceId))
  ) {
    return getStatus()
  }
  writeClickUpAccount({
    ...account,
    activeWorkspaceId: workspaceId === 'all' ? account.activeWorkspaceId : workspaceId,
    selectedWorkspaceId: workspaceId
  })
  return getStatus()
}

export async function testConnection(): Promise<
  { ok: true; viewer: ClickUpViewer } | { ok: false; error: string }
> {
  let token: string | null
  try {
    token = readClickUpToken()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!token) {
    return { ok: false, error: 'Not connected to ClickUp.' }
  }
  await acquire()
  try {
    const response = await requestWithToken<{ user?: unknown }>(token, '/user')
    const viewer = normalizeClickUpViewer(response.user)
    return viewer
      ? { ok: true, viewer }
      : { ok: false, error: 'ClickUp returned an invalid user profile.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ClickUpApiError && (error.status === 401 || error.status === 403)
}
