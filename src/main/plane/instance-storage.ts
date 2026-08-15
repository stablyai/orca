import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { PlaneInstance, PlaneInstanceSelection } from '../../shared/plane/types'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import {
  getInstanceFilePath,
  getInstanceTokenDir,
  getInstanceTokenPath,
  getOrcaDir
} from './storage-paths'

export type PlaneInstanceFile = {
  version: 1
  activeInstanceId: string | null
  selectedInstanceId: PlaneInstanceSelection | null
  instances: PlaneInstance[]
}

const SERVICE = 'Plane'
const credentialErrors = new Map<string, string>()
let cachedTokens = new Map<string, string>()
let cachedInstanceFile: PlaneInstanceFile | null = null
let instanceFileLoadedFromDisk = false

export function ensureDirs(): void {
  mkdirSync(getOrcaDir(), { recursive: true })
  mkdirSync(getInstanceTokenDir(), { recursive: true })
}

export function getInstanceFile(): PlaneInstanceFile {
  if (!instanceFileLoadedFromDisk || !cachedInstanceFile) {
    cachedInstanceFile = readInstanceFileFromDisk()
    instanceFileLoadedFromDisk = true
  }
  return cachedInstanceFile
}

export function writeInstanceFile(file: PlaneInstanceFile): void {
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

export function readToken(instanceId: string): string | null {
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

export function writeToken(instanceId: string, token: string): void {
  cachedTokens.set(instanceId, token)
  writeEncryptedCredential(SERVICE, getInstanceTokenPath(instanceId), token)
}

export function deleteTokens(instanceIds: string[]): void {
  for (const id of instanceIds) {
    cachedTokens.delete(id)
    credentialErrors.delete(id)
    try {
      unlinkSync(getInstanceTokenPath(id))
    } catch {}
  }
}

export function getCredentialError(instanceId: string): string | null {
  return credentialErrors.get(instanceId) ?? null
}

export function captureCredentialError(instanceId: string, error: unknown): void {
  if (error instanceof CredentialDecryptionError) {
    credentialErrors.set(instanceId, error.message)
  }
}

function emptyInstanceFile(): PlaneInstanceFile {
  return { version: 1, activeInstanceId: null, selectedInstanceId: null, instances: [] }
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

export function hasStoredToken(id: string): boolean {
  return cachedTokens.has(id) || credentialFileHasContent(getInstanceTokenPath(id))
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
    authMode: raw.authMode === 'oauth' ? 'oauth' : 'apiKey',
    displayName: raw.displayName,
    email: typeof raw.email === 'string' ? raw.email : null,
    userId: typeof raw.userId === 'string' ? raw.userId : null,
    credentialRevision:
      typeof raw.credentialRevision === 'number' && Number.isFinite(raw.credentialRevision)
        ? raw.credentialRevision
        : undefined
  }
}
