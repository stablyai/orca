import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import type { PlaneAuthType, PlaneViewer, PlaneWorkspace } from '../../shared/plane-types'

export type PlaneConfigFile = {
  version: 1
  instanceType: PlaneAuthType
  instanceUrl: string
  viewer: PlaneViewer | null
  activeWorkspaceSlug: string | null
  workspaces: PlaneWorkspace[]
}

let cachedConfigFile: PlaneConfigFile | null = null
let configFileLoaded = false
let cachedToken: string | null = null
export let credentialError: string | undefined = undefined

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getConfigFilePath(): string {
  return join(getOrcaDir(), 'plane-config.json')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'plane-token.enc')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyConfigFile(): PlaneConfigFile {
  return {
    version: 1,
    instanceType: 'cloud',
    instanceUrl: 'https://api.plane.so',
    viewer: null,
    activeWorkspaceSlug: null,
    workspaces: []
  }
}

export function hasStoredToken(): boolean {
  return cachedToken !== null || credentialFileHasContent(getTokenPath())
}

function readConfigFileFromDisk(): PlaneConfigFile {
  const path = getConfigFilePath()
  if (!existsSync(path)) {
    return emptyConfigFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<PlaneConfigFile>
    return {
      version: 1,
      instanceType: parsed.instanceType === 'self_hosted' ? 'self_hosted' : 'cloud',
      instanceUrl: typeof parsed.instanceUrl === 'string' ? parsed.instanceUrl : 'https://api.plane.so',
      viewer: parsed.viewer ?? null,
      activeWorkspaceSlug: parsed.activeWorkspaceSlug ?? null,
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : []
    }
  } catch {
    return emptyConfigFile()
  }
}

export function getConfigFile(): PlaneConfigFile {
  if (!configFileLoaded || !cachedConfigFile) {
    cachedConfigFile = readConfigFileFromDisk()
    configFileLoaded = true
  }
  return cachedConfigFile
}

export function writeConfigFile(file: PlaneConfigFile): void {
  ensureOrcaDir()
  cachedConfigFile = file
  configFileLoaded = true
  writeFileSync(getConfigFilePath(), JSON.stringify(cachedConfigFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function writeEncryptedToken(path: string, apiToken: string): void {
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(path, getSecretStore().encryptString(apiToken), { mode: 0o600 })
    return
  }
  console.warn('[plane] secret encryption unavailable — storing token in plaintext')
  writeFileSync(path, apiToken, { encoding: 'utf-8', mode: 0o600 })
}

export function readToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken
  }
  const path = getTokenPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('Plane', readFileSync(path))
    if (token) {
      cachedToken = token
      credentialError = undefined
      return token
    }
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialError = error.message
    }
    throw error
  }
  return null
}

export function saveToken(apiToken: string): void {
  ensureOrcaDir()
  writeEncryptedToken(getTokenPath(), apiToken)
  cachedToken = apiToken
  credentialError = undefined
}

export function deleteToken(): void {
  cachedToken = null
  credentialError = undefined
  const path = getTokenPath()
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // Best-effort cleanup
    }
  }
}

export function clearPlaneConfig(): void {
  deleteToken()
  const path = getConfigFilePath()
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // Best-effort cleanup
    }
  }
  cachedConfigFile = emptyConfigFile()
  configFileLoaded = true
}
