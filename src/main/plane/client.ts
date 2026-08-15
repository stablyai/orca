import { fetchPlaneViewer, instanceId, normalizeBaseUrl } from './api-request'
import {
  captureCredentialError,
  deleteTokens,
  ensureDirs,
  getCredentialError,
  getInstanceFile,
  hasStoredToken,
  readToken,
  writeInstanceFile,
  writeToken
} from './instance-storage'
import type {
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneInstance,
  PlaneInstanceSelection,
  PlaneOAuthConnectArgs,
  PlaneViewer
} from '../../shared/plane/types'
import { connectOAuth } from './oauth'

export type PlaneClientForInstance = {
  instance: PlaneInstance
  auth:
    | { kind: 'apiKey'; apiKey: string }
    | {
        kind: 'oauth'
        accessToken: string
        refreshToken?: string
        expiresAt?: number
        clientId: string
        clientSecret: string
      }
}

export async function connect(
  args: PlaneConnectArgs
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  try {
    const baseUrl = normalizeBaseUrl(args.baseUrl)
    const workspaceSlug = args.workspaceSlug.trim()
    const apiKey = args.apiKey.trim()
    if (!workspaceSlug || !apiKey) {
      return { ok: false, error: 'Workspace slug and API key are required' }
    }
    const id = instanceId(baseUrl, workspaceSlug)
    const viewer = await fetchPlaneViewer({
      instance: { id, baseUrl, workspaceSlug, displayName: workspaceSlug },
      auth: { kind: 'apiKey', apiKey }
    })
    ensureDirs()
    writeToken(id, apiKey)
    const file = getInstanceFile()
    const existing = file.instances.filter((instance) => instance.id !== id)
    const instance: PlaneInstance = {
      id,
      baseUrl,
      workspaceSlug,
      authMode: 'apiKey',
      displayName: viewer.displayName || workspaceSlug,
      email: viewer.email ?? null,
      userId: viewer.id ?? null,
      credentialRevision: Date.now()
    }
    writeInstanceFile({
      version: 1,
      activeInstanceId: id,
      selectedInstanceId: id,
      instances: [instance, ...existing]
    })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function connectWithOAuth(
  args: PlaneOAuthConnectArgs
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  return connectOAuth(args, {
    getInstanceFile,
    writeInstanceFile,
    ensureDirs,
    setToken: writeToken
  })
}

export function disconnect(instanceId?: string): void {
  const file = getInstanceFile()
  const ids = instanceId ? [instanceId] : file.instances.map((instance) => instance.id)
  deleteTokens(ids)
  const instances = file.instances.filter((instance) => !ids.includes(instance.id))
  const activeInstanceId = instances.some((instance) => instance.id === file.activeInstanceId)
    ? file.activeInstanceId
    : (instances[0]?.id ?? null)
  const selectedInstanceId =
    file.selectedInstanceId === 'all'
      ? 'all'
      : file.selectedInstanceId &&
          instances.some((instance) => instance.id === file.selectedInstanceId)
        ? file.selectedInstanceId
        : activeInstanceId
  writeInstanceFile({
    ...file,
    activeInstanceId,
    selectedInstanceId,
    instances
  })
}

export function selectInstance(instanceId: PlaneInstanceSelection): PlaneConnectionStatus {
  const file = getInstanceFile()
  if (instanceId !== 'all' && !file.instances.some((instance) => instance.id === instanceId)) {
    return getStatus()
  }
  writeInstanceFile({ ...file, selectedInstanceId: instanceId })
  return getStatus()
}

export function getStatus(): PlaneConnectionStatus {
  const file = getInstanceFile()
  const instances = file.instances.filter((instance) => hasStoredToken(instance.id))
  const activeInstanceId =
    file.activeInstanceId && instances.some((instance) => instance.id === file.activeInstanceId)
      ? file.activeInstanceId
      : (instances[0]?.id ?? null)
  const selectedInstanceId =
    file.selectedInstanceId === 'all'
      ? 'all'
      : file.selectedInstanceId &&
          instances.some((instance) => instance.id === file.selectedInstanceId)
        ? file.selectedInstanceId
        : activeInstanceId
  const active = instances.find((instance) => instance.id === activeInstanceId) ?? null
  return {
    connected: instances.length > 0,
    activeInstanceId,
    selectedInstanceId,
    instances,
    viewer: active
      ? { id: active.userId ?? undefined, displayName: active.displayName, email: active.email }
      : null,
    credentialError: activeInstanceId ? getCredentialError(activeInstanceId) : null
  }
}

export async function testConnection(
  instanceId?: string
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  try {
    const client = getClient(instanceId)
    return { ok: true, viewer: await fetchPlaneViewer(client) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function getClient(instanceId?: string): PlaneClientForInstance {
  const file = getInstanceFile()
  const id =
    instanceId ??
    (file.selectedInstanceId === 'all' ? file.activeInstanceId : file.selectedInstanceId) ??
    file.activeInstanceId
  const instance = file.instances.find((item) => item.id === id)
  if (!instance) {
    throw new Error('Plane is not connected')
  }
  try {
    const token = readToken(instance.id)
    if (!token) {
      throw new Error('Plane credential is missing')
    }
    if (instance.authMode === 'oauth') {
      const parsed = JSON.parse(token) as {
        accessToken?: unknown
        refreshToken?: unknown
        expiresAt?: unknown
        clientId?: unknown
        clientSecret?: unknown
      }
      if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) {
        throw new Error('Plane OAuth token is missing')
      }
      if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') {
        throw new Error('Plane OAuth client credentials are missing. Reconnect Plane to continue.')
      }
      return {
        instance,
        auth: {
          kind: 'oauth',
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret
        }
      }
    }
    return { instance, auth: { kind: 'apiKey', apiKey: token } }
  } catch (error) {
    captureCredentialError(instance.id, error)
    throw error
  }
}

export function getClients(selection?: PlaneInstanceSelection): PlaneClientForInstance[] {
  const file = getInstanceFile()
  const effectiveSelection = selection ?? file.selectedInstanceId ?? file.activeInstanceId
  if (effectiveSelection === 'all') {
    return file.instances.map((instance) => getClient(instance.id))
  }
  return [getClient(effectiveSelection ?? undefined)]
}
