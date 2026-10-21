import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  RuntimeHostDescriptorSchema,
  type RuntimeHostDescriptor
} from '../../shared/runtime-host-descriptor'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { withFileTransactionLock } from '../file-transaction-lock'
import type { RuntimeSourceStamp } from '../../shared/runtime-source-env'

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
export async function loadOrCreateHostInstallationId(userDataPath: string): Promise<string> {
  const filePath = join(userDataPath, HOST_INSTALLATION_FILENAME)
  const current = readInstallation(filePath)
  if (current.kind === 'valid') {
    return current.installationId
  }
  // Why the lock and a re-read: a creator or repairer decides only after any racing one has published.
  return await withFileTransactionLock(filePath, async () => {
    const locked = readInstallation(filePath)
    if (locked.kind === 'valid') {
      return locked.installationId
    }
    const installationId = randomUUID()
    const draftPath = `${filePath}.${installationId}.draft`
    try {
      writeFileSync(draftPath, JSON.stringify({ installationId }), { flag: 'wx', mode: 0o600 })
      renameSync(draftPath, filePath)
    } finally {
      rmSync(draftPath, { force: true })
    }
    return installationId
  })
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
export async function loadHostDescriptor(
  userDataPath: string,
  readMachineIdentity: () => string | null = profileStateAccessMachineIdentity
): Promise<RuntimeHostDescriptor | null> {
  let installationId: string
  try {
    installationId = await loadOrCreateHostInstallationId(userDataPath)
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

/** Null until this runtime publishes a descriptor; unstamped processes keep the unfenced CLI path. */
export function getRuntimeSourceStamp(
  runtime: { getRuntimeId?: () => string } | null | undefined,
  userDataPath?: string
): RuntimeSourceStamp | null {
  const runtimeId = runtime?.getRuntimeId?.()
  const descriptor = runtimeId ? getPublishedHostDescriptor(runtimeId) : null
  return runtimeId && descriptor
    ? {
        sourceId: descriptor.installationId,
        incarnation: runtimeId,
        ...(userDataPath ? { profilePath: userDataPath } : {})
      }
    : null
}
