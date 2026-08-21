import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import type { ClickUpConnectionStatus, ClickUpViewer, ClickUpWorkspace, ClickUpWorkspaceSelection } from '../../shared/clickup-types'
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

const CLICKUP_API_BASE_URL = 'https://api.clickup.com/api/v2'
const MAX_CONCURRENT = 4
const CLICKUP_REQUEST_TIMEOUT_MS = 30_000

let running = 0
const queue: (() => void)[] = []

export type ClickUpClientForWorkspace = {
  workspace: ClickUpWorkspace
  token: string
}

export class ClickUpApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ClickUpApiError'
    this.status = status
  }
}

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return
  }
  await new Promise<void>((resolve) => {
    queue.push(() => {
      running += 1
      resolve()
    })
  })
}

function release(): void {
  running -= 1
  queue.shift()?.()
}

async function readApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { err?: string; error?: string; message?: string }
    const message = data.err ?? data.error ?? data.message
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  } catch {
    // Fall through to the HTTP status when ClickUp does not return JSON.
  }
  return response.statusText || `ClickUp request failed (${response.status})`
}

async function requestWithToken<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const url = `${CLICKUP_API_BASE_URL}${path}`
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: url
  }).catch(() => undefined)
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Authorization', token)
  if (init?.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await net.fetch(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(CLICKUP_REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new ClickUpApiError(await readApiError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}

export async function clickUpRequest<T>(
  client: ClickUpClientForWorkspace,
  path: string,
  init?: RequestInit
): Promise<T> {
  await acquire()
  try {
    return await requestWithToken<T>(client.token, path, init)
  } finally {
    release()
  }
}

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

export function disconnect(): void {
  deleteStoredClickUpConnection()
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
