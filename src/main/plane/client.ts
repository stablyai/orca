import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  getInstanceFilePath,
  getInstanceTokenDir,
  getInstanceTokenPath,
  getOrcaDir
} from './storage-paths'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import type {
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneInstance,
  PlaneInstanceSelection,
  PlaneViewer
} from '../../shared/plane/types'

type PlaneInstanceFile = {
  version: 1
  activeInstanceId: string | null
  selectedInstanceId: PlaneInstanceSelection | null
  instances: PlaneInstance[]
}

export type PlaneClientForInstance = {
  instance: PlaneInstance
  apiKey: string
}

const SERVICE = 'Plane'
let cachedTokens = new Map<string, string>()
const credentialErrors = new Map<string, string>()
let cachedInstanceFile: PlaneInstanceFile | null = null
let instanceFileLoadedFromDisk = false

function ensureDirs(): void {
  mkdirSync(getOrcaDir(), { recursive: true })
  mkdirSync(getInstanceTokenDir(), { recursive: true })
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function instanceId(baseUrl: string, workspaceSlug: string): string {
  return `${normalizeBaseUrl(baseUrl)}::${workspaceSlug.trim()}`
}

function emptyInstanceFile(): PlaneInstanceFile {
  return { version: 1, activeInstanceId: null, selectedInstanceId: null, instances: [] }
}

function normalizeInstance(input: unknown): PlaneInstance | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const raw = input as Record<string, unknown>
  if (
    typeof raw.id !== 'string' ||
    typeof raw.baseUrl !== 'string' ||
    typeof raw.workspaceSlug !== 'string' ||
    typeof raw.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: raw.id,
    baseUrl: raw.baseUrl,
    workspaceSlug: raw.workspaceSlug,
    displayName: raw.displayName,
    email: typeof raw.email === 'string' ? raw.email : null,
    userId: typeof raw.userId === 'string' ? raw.userId : null,
    credentialRevision:
      typeof raw.credentialRevision === 'number' && Number.isFinite(raw.credentialRevision)
        ? raw.credentialRevision
        : undefined
  }
}

function hasStoredToken(id: string): boolean {
  return cachedTokens.has(id) || credentialFileHasContent(getInstanceTokenPath(id))
}

function readInstanceFileFromDisk(): PlaneInstanceFile {
  const path = getInstanceFilePath()
  if (!existsSync(path)) {
    return emptyInstanceFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PlaneInstanceFile>
    const instances = Array.isArray(parsed.instances)
      ? parsed.instances
          .map((instance) => normalizeInstance(instance))
          .filter((instance): instance is PlaneInstance => instance !== null)
          .filter((instance) => hasStoredToken(instance.id))
      : []
    const activeInstanceId =
      typeof parsed.activeInstanceId === 'string' &&
      instances.some((instance) => instance.id === parsed.activeInstanceId)
        ? parsed.activeInstanceId
        : (instances[0]?.id ?? null)
    const selectedInstanceId =
      parsed.selectedInstanceId === 'all' ||
      (typeof parsed.selectedInstanceId === 'string' &&
        instances.some((instance) => instance.id === parsed.selectedInstanceId))
        ? parsed.selectedInstanceId
        : activeInstanceId
    return { version: 1, activeInstanceId, selectedInstanceId, instances }
  } catch {
    return emptyInstanceFile()
  }
}

function getInstanceFile(): PlaneInstanceFile {
  if (!instanceFileLoadedFromDisk || !cachedInstanceFile) {
    cachedInstanceFile = readInstanceFileFromDisk()
    instanceFileLoadedFromDisk = true
  }
  return cachedInstanceFile
}

function writeInstanceFile(file: PlaneInstanceFile): void {
  ensureDirs()
  const instances = file.instances.filter((instance) => hasStoredToken(instance.id))
  const selectableIds = new Set(instances.map((instance) => instance.id))
  const activeInstanceId =
    file.activeInstanceId && selectableIds.has(file.activeInstanceId)
      ? file.activeInstanceId
      : (instances[0]?.id ?? null)
  const selectedInstanceId =
    file.selectedInstanceId === 'all'
      ? 'all'
      : file.selectedInstanceId && selectableIds.has(file.selectedInstanceId)
        ? file.selectedInstanceId
        : activeInstanceId
  cachedInstanceFile = { version: 1, activeInstanceId, selectedInstanceId, instances }
  instanceFileLoadedFromDisk = true
  writeFileSync(getInstanceFilePath(), JSON.stringify(cachedInstanceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function readToken(instanceId: string): string | null {
  const cached = cachedTokens.get(instanceId)
  if (cached) {
    return cached
  }
  const path = getInstanceTokenPath(instanceId)
  if (!existsSync(path)) {
    return null
  }
  const token = readStoredCredentialToken(SERVICE, readFileSync(path))
  if (token) {
    cachedTokens.set(instanceId, token)
    credentialErrors.delete(instanceId)
  }
  return token
}

export async function connect(args: PlaneConnectArgs): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  const baseUrl = normalizeBaseUrl(args.baseUrl)
  const workspaceSlug = args.workspaceSlug.trim()
  const apiKey = args.apiKey.trim()
  if (!workspaceSlug || !apiKey) {
    return { ok: false, error: 'Workspace slug and API key are required' }
  }
  const id = instanceId(baseUrl, workspaceSlug)
  try {
    const viewer = await fetchPlaneViewer({ instance: { id, baseUrl, workspaceSlug, displayName: workspaceSlug }, apiKey })
    ensureDirs()
    cachedTokens.set(id, apiKey)
    writeEncryptedCredential(SERVICE, getInstanceTokenPath(id), apiKey)
    const file = getInstanceFile()
    const existing = file.instances.filter((instance) => instance.id !== id)
    const instance: PlaneInstance = {
      id,
      baseUrl,
      workspaceSlug,
      displayName: viewer.displayName || workspaceSlug,
      email: viewer.email ?? null,
      userId: viewer.id ?? null,
      credentialRevision: Date.now()
    }
    writeInstanceFile({ version: 1, activeInstanceId: id, selectedInstanceId: id, instances: [instance, ...existing] })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function disconnect(instanceId?: string): void {
  const file = getInstanceFile()
  const ids = instanceId ? [instanceId] : file.instances.map((instance) => instance.id)
  for (const id of ids) {
    cachedTokens.delete(id)
    credentialErrors.delete(id)
    try {
      unlinkSync(getInstanceTokenPath(id))
    } catch {}
  }
  writeInstanceFile({ ...file, instances: file.instances.filter((instance) => !ids.includes(instance.id)) })
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
      : file.selectedInstanceId && instances.some((instance) => instance.id === file.selectedInstanceId)
        ? file.selectedInstanceId
        : activeInstanceId
  const active = instances.find((instance) => instance.id === activeInstanceId) ?? null
  return {
    connected: instances.length > 0,
    activeInstanceId,
    selectedInstanceId,
    instances,
    viewer: active ? { id: active.userId ?? undefined, displayName: active.displayName, email: active.email } : null,
    credentialError: activeInstanceId ? (credentialErrors.get(activeInstanceId) ?? null) : null
  }
}

export async function testConnection(instanceId?: string): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  try {
    const client = getClient(instanceId)
    return { ok: true, viewer: await fetchPlaneViewer(client) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function getClient(instanceId?: string): PlaneClientForInstance {
  const file = getInstanceFile()
  const id = instanceId ?? (file.selectedInstanceId === 'all' ? file.activeInstanceId : file.selectedInstanceId) ?? file.activeInstanceId
  const instance = file.instances.find((item) => item.id === id)
  if (!instance) {
    throw new Error('Plane is not connected')
  }
  try {
    const apiKey = readToken(instance.id)
    if (!apiKey) {
      throw new Error('Plane API key is missing')
    }
    return { instance, apiKey }
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(instance.id, error.message)
    }
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

export async function planeFetch<T>(client: PlaneClientForInstance, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${client.instance.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': client.apiKey,
      ...init.headers
    }
  })
  if (!response.ok) {
    throw new Error(`Plane API ${response.status}: ${await response.text()}`.slice(0, 300))
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

async function fetchPlaneViewer(client: PlaneClientForInstance): Promise<PlaneViewer> {
  const data = await planeFetch<Record<string, unknown>>(client, '/api/v1/users/me/')
  const id = stringField(data, 'id') ?? undefined
  const displayName = stringField(data, 'display_name') ?? stringField(data, 'first_name') ?? 'Plane user'
  return { id, displayName, email: stringField(data, 'email') }
}

export function apiPath(client: PlaneClientForInstance, suffix: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(client.instance.workspaceSlug)}${suffix}`
}

export function planeWebUrl(client: PlaneClientForInstance, identifier: string): string {
  return `${client.instance.baseUrl}/${client.instance.workspaceSlug}/issues/${identifier}`
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
