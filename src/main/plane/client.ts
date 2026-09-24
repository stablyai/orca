import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneViewer,
  PlaneWorkspace
} from '../../shared/plane-types'
import {
  clearPlaneConfig,
  credentialError,
  getConfigFile,
  hasStoredToken,
  readToken,
  saveToken,
  writeConfigFile
} from './plane-credential-store'
import { normalizePlaneBaseUrl, PlaneApiError, planeRequest } from './authenticated-request'

export type PlaneClientConfig = {
  instanceUrl: string
  apiToken: string
  activeWorkspaceSlug: string | null
}

export function getClient(): PlaneClientConfig | null {
  const file = getConfigFile()
  if (!hasStoredToken()) {
    return null
  }
  let token: string | null
  try {
    token = readToken()
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      return null
    }
    throw error
  }
  if (!token) {
    return null
  }
  return {
    instanceUrl: file.instanceUrl,
    apiToken: token,
    activeWorkspaceSlug: file.activeWorkspaceSlug
  }
}

export function getStatus(): PlaneConnectionStatus {
  const file = getConfigFile()
  const connected = hasStoredToken() && file.viewer !== null
  return {
    connected,
    viewer: file.viewer,
    instanceUrl: file.instanceUrl,
    authType: file.instanceType,
    workspaces: file.workspaces,
    activeWorkspaceSlug: file.activeWorkspaceSlug,
    selectedWorkspaceSlug: file.activeWorkspaceSlug,
    ...(credentialError ? { credentialError } : {})
  }
}

type PlaneRawUser = {
  id: string
  first_name?: string
  last_name?: string
  email?: string | null
  avatar?: string
  username?: string
}

type PlaneRawWorkspace = {
  id: string
  name: string
  slug: string
  url?: string
  logo?: string
}

export async function connect(
  args: PlaneConnectArgs
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  let instanceUrl: string
  try {
    instanceUrl = normalizePlaneBaseUrl(args.instanceUrl)
  } catch {
    return { ok: false, error: 'Enter a valid Plane instance URL.' }
  }

  const apiToken = args.apiToken.trim()
  if (!apiToken) {
    return { ok: false, error: 'API token is required.' }
  }

  try {
    const rawUser = await planeRequest<PlaneRawUser>(instanceUrl, apiToken, '/api/v1/users/me/')
    const displayName =
      [rawUser.first_name, rawUser.last_name].filter(Boolean).join(' ') ||
      rawUser.username ||
      rawUser.email ||
      'Plane User'

    const viewer: PlaneViewer = {
      id: rawUser.id,
      displayName,
      email: rawUser.email ?? null,
      avatarUrl: rawUser.avatar,
      username: rawUser.username
    }

    let workspaces: PlaneWorkspace[] = []
    try {
      const rawWorkspaces = await planeRequest<PlaneRawWorkspace[]>(
        instanceUrl,
        apiToken,
        '/api/v1/workspaces/'
      )
      if (Array.isArray(rawWorkspaces)) {
        workspaces = rawWorkspaces.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          url: `${instanceUrl}/${w.slug}`,
          logo: w.logo
        }))
      }
    } catch {
      // Workspaces fetch failure shouldn't completely block connection if user profile worked
    }

    saveToken(apiToken)
    writeConfigFile({
      version: 1,
      instanceType: args.instanceType,
      instanceUrl,
      viewer,
      activeWorkspaceSlug: workspaces[0]?.slug ?? null,
      workspaces
    })

    return { ok: true, viewer }
  } catch (error) {
    if (error instanceof PlaneApiError) {
      if (error.status === 401 || error.status === 403) {
        return { ok: false, error: 'Invalid API token or insufficient permissions.' }
      }
      return { ok: false, error: error.message }
    }
    const message = error instanceof Error ? error.message : 'Failed to connect to Plane.'
    return { ok: false, error: message }
  }
}

export function disconnect(): void {
  clearPlaneConfig()
}

export function selectWorkspace(workspaceSlug: string): PlaneConnectionStatus {
  const file = getConfigFile()
  if (file.workspaces.some((w) => w.slug === workspaceSlug)) {
    writeConfigFile({
      ...file,
      activeWorkspaceSlug: workspaceSlug
    })
  }
  return getStatus()
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const client = getClient()
  if (!client) {
    return { ok: false, error: 'Plane is not connected.' }
  }
  try {
    await planeRequest(client.instanceUrl, client.apiToken, '/api/v1/users/me/')
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection test failed'
    return { ok: false, error: message }
  }
}
