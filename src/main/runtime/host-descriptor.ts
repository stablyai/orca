import { createHmac, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  RuntimeHostDescriptorSchema,
  type RuntimeHostDescriptor
} from '../../shared/runtime-host-descriptor'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'

export const HOST_INSTALLATION_FILENAME = 'host-installation.json'
const MAX_INSTALLATION_FILE_BYTES = 4 * 1024
const InstallationFileSchema = RuntimeHostDescriptorSchema.pick({ installationId: true })

type InstallationRead =
  | { kind: 'valid'; installationId: string }
  | { kind: 'missing' }
  | { kind: 'malformed' }

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function readInstallation(filePath: string): InstallationRead {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { kind: 'missing' }
    }
    // Why throw: regenerating over a file we merely cannot read would silently fork this host's identity.
    throw error
  }
  if (raw.length > MAX_INSTALLATION_FILE_BYTES) {
    return { kind: 'malformed' }
  }
  try {
    const parsed = InstallationFileSchema.safeParse(JSON.parse(raw))
    return parsed.success
      ? { kind: 'valid', installationId: parsed.data.installationId }
      : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}

/** Reads this profile's installation id, creating it once; concurrent creators converge on one. */
export function loadOrCreateHostInstallationId(userDataPath: string): string {
  const filePath = join(userDataPath, HOST_INSTALLATION_FILENAME)
  const current = readInstallation(filePath)
  if (current.kind === 'valid') {
    return current.installationId
  }
  const installationId = randomUUID()
  const draftPath = `${filePath}.${installationId}.draft`
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(draftPath, JSON.stringify({ installationId }), { flag: 'wx', mode: 0o600 })
  try {
    if (current.kind === 'malformed') {
      renameSync(draftPath, filePath)
    } else {
      publishWithoutReplacing(draftPath, filePath)
    }
  } finally {
    rmSync(draftPath, { force: true })
  }
  const published = readInstallation(filePath)
  if (published.kind !== 'valid') {
    throw new Error(`Host installation id at ${filePath} could not be published`)
  }
  return published.installationId
}

function publishWithoutReplacing(draftPath: string, filePath: string): void {
  try {
    // Why a hard link: it appears complete or not at all, and never replaces a racing creator's id.
    linkSync(draftPath, filePath)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') {
      return
    }
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') {
      throw error
    }
    // Filesystems without hard links: exclusive create still never replaces another id.
    try {
      writeFileSync(filePath, readFileSync(draftPath), { flag: 'wx', mode: 0o600 })
    } catch (fallbackError) {
      if (errorCode(fallbackError) !== 'EEXIST') {
        throw fallbackError
      }
    }
  }
}

/** Keyed by the installation id so the binding never works as a cross-app machine identifier. */
export function computeHostMachineBinding(
  installationId: string,
  machineIdentity: string,
  userDataPath: string
): string {
  return createHmac('sha256', installationId)
    .update(`${machineIdentity}\0${resolve(userDataPath)}`)
    .digest('base64url')
}

/** Null when the profile cannot hold an installation id; the binding is dropped when no machine id is readable. */
export function loadHostDescriptor(
  userDataPath: string,
  readMachineIdentity: () => string | null = profileStateAccessMachineIdentity
): RuntimeHostDescriptor | null {
  let installationId: string
  try {
    installationId = loadOrCreateHostInstallationId(userDataPath)
  } catch (error) {
    console.warn('[runtime] Host descriptor unavailable:', error)
    return null
  }
  const machineIdentity = readMachineIdentity()
  return machineIdentity
    ? {
        installationId,
        machineBinding: computeHostMachineBinding(installationId, machineIdentity, userDataPath)
      }
    : { installationId }
}

// Keyed by runtime id because the RPC server that owns the profile loads it, while status.get only sees the runtime.
const publishedByRuntimeId = new Map<string, RuntimeHostDescriptor>()

export function publishHostDescriptor(
  runtimeId: string,
  descriptor: RuntimeHostDescriptor | null
): void {
  if (descriptor) {
    publishedByRuntimeId.set(runtimeId, descriptor)
  } else {
    publishedByRuntimeId.delete(runtimeId)
  }
}

export function getPublishedHostDescriptor(runtimeId: string): RuntimeHostDescriptor | null {
  return publishedByRuntimeId.get(runtimeId) ?? null
}
