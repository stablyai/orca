// Copies of one machine image share the pairing identity files; ORCA_INSTANCE_ID tells the copies apart.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { bestEffortFsyncDirectorySync, writeDurableSecureJsonFile } from '../../shared/secure-file'
import { E2EE_KEYPAIR_FILENAME } from '../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import { writeNewE2EEKeypair } from './rpc/server/pairing/e2ee-keypair'
import { DEVICE_REGISTRY_FILENAME } from './rpc/server/pairing/mobile-pairing-files'
import { HOST_INSTALLATION_FILENAME } from './hosts/platform-probe/host-descriptor'

export const HOST_INSTANCE_FILENAME = 'orca-host-instance.json'
export const ORCA_INSTANCE_ID_ENV = 'ORCA_INSTANCE_ID'
const MAX_HOST_INSTANCE_FILE_BYTES = 4 * 1024
const IDENTITY_FILENAMES = [
  E2EE_KEYPAIR_FILENAME,
  DEVICE_REGISTRY_FILENAME,
  HOST_INSTALLATION_FILENAME
] as const
const STAGED_SUFFIX = '.next'

/** `instanceId` is hashed so the file never republishes a provisioner value. `rotating` is written
 * only once every new file is staged beside the live one; a start that sees it publishes them. */
const HostInstanceMarkerSchema = z.object({
  v: z.literal(1),
  instanceId: z.string().min(1).optional(),
  rotating: z.literal(true).optional()
})
type HostInstanceMarker = z.infer<typeof HostInstanceMarkerSchema>

export type HostIdentityOutcome =
  | { kind: 'unchanged' }
  | { kind: 'recorded' }
  | { kind: 'rotated'; reason: 'instance_changed' | 'interrupted_rotation' }
  /** Nothing was changed on disk, so the existing identity is still whole and safe to serve. */
  | { kind: 'kept'; error: unknown }

export type HostIdentityWrite = (path: string, value: unknown) => boolean

/** The rotation failed before any live identity file was touched. */
export class HostIdentityRotationNotStartedError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not write the new pairing identity; the current one is unchanged: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = 'HostIdentityRotationNotStartedError'
  }
}

export function hostInstanceIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ORCA_INSTANCE_ID_ENV]?.trim()
  return raw ? createHash('sha256').update(`orca-host-instance\0${raw}`).digest('hex') : null
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function readMarker(markerPath: string): HostInstanceMarker | null {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
  if (raw.length > MAX_HOST_INSTANCE_FILE_BYTES) {
    return null
  }
  try {
    const parsed = HostInstanceMarkerSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    // Writes are atomic, so a bad file was edited by hand; re-record it rather than unpair.
    return null
  }
}

function markerFor(instanceId: string | undefined, rotating = false): HostInstanceMarker {
  return { v: 1, ...(instanceId ? { instanceId } : {}), ...(rotating ? { rotating: true } : {}) }
}

function stagedIdentityPaths(userDataPath: string): { live: string; staged: string }[] {
  return IDENTITY_FILENAMES.map((name) => {
    const live = join(userDataPath, name)
    return { live, staged: `${live}${STAGED_SUFFIX}` }
  })
}

/** Writes the new identity beside the live files, which stay untouched. */
function stageNewIdentity(userDataPath: string, write: HostIdentityWrite): void {
  const stage: HostIdentityWrite = (path, value) => write(`${path}${STAGED_SUFFIX}`, value)
  writeNewE2EEKeypair(userDataPath, stage)
  stage(join(userDataPath, DEVICE_REGISTRY_FILENAME), [])
  stage(join(userDataPath, HOST_INSTALLATION_FILENAME), { installationId: randomUUID() })
}

function discardStagedIdentity(userDataPath: string): void {
  for (const { staged } of stagedIdentityPaths(userDataPath)) {
    try {
      rmSync(staged, { force: true })
    } catch {
      // A leftover staged file is ignored until a later rotation overwrites it.
    }
  }
}

/** Moves each staged file over its live file. Staging finished before the `rotating` marker was
 * written, so a missing staged file was already moved by an earlier, interrupted publish. */
function publishStagedIdentity(
  userDataPath: string,
  instanceId: string | undefined,
  write: HostIdentityWrite
): void {
  for (const { live, staged } of stagedIdentityPaths(userDataPath)) {
    try {
      renameSync(staged, live)
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
    }
  }
  bestEffortFsyncDirectorySync(userDataPath)
  write(join(userDataPath, HOST_INSTANCE_FILENAME), markerFor(instanceId))
}

/**
 * New keypair, no paired devices, new installation id. Callers must hold the profile lock.
 * Throws HostIdentityRotationNotStartedError when the old identity is still whole; any other
 * error means the next start must finish the rotation before serving.
 */
export function rotateHostIdentity(
  userDataPath: string,
  instanceId: string | null = hostInstanceIdFromEnv(),
  write: HostIdentityWrite = writeDurableSecureJsonFile
): void {
  try {
    stageNewIdentity(userDataPath, write)
    write(join(userDataPath, HOST_INSTANCE_FILENAME), markerFor(instanceId ?? undefined, true))
  } catch (error) {
    discardStagedIdentity(userDataPath)
    throw new HostIdentityRotationNotStartedError(error)
  }
  publishStagedIdentity(userDataPath, instanceId ?? undefined, write)
}

/**
 * Rotates only when ORCA_INSTANCE_ID is set and differs from the id recorded with this identity.
 * Unset never rotates; the first id seen is recorded so adopting the variable keeps pairings.
 * Throws only when a started rotation cannot be finished, so old and new files may be mixed.
 */
export function ensureHostInstanceIdentity(
  userDataPath: string,
  instanceId: string | null = hostInstanceIdFromEnv(),
  write: HostIdentityWrite = writeDurableSecureJsonFile
): HostIdentityOutcome {
  const markerPath = join(userDataPath, HOST_INSTANCE_FILENAME)
  const stored = readMarker(markerPath)
  if (stored?.rotating) {
    publishStagedIdentity(userDataPath, instanceId ?? stored.instanceId, write)
    return { kind: 'rotated', reason: 'interrupted_rotation' }
  }
  if (!instanceId || stored?.instanceId === instanceId) {
    return { kind: 'unchanged' }
  }
  if (!stored?.instanceId) {
    try {
      write(markerPath, markerFor(instanceId))
    } catch (error) {
      return { kind: 'kept', error }
    }
    return { kind: 'recorded' }
  }
  try {
    rotateHostIdentity(userDataPath, instanceId, write)
  } catch (error) {
    if (error instanceof HostIdentityRotationNotStartedError) {
      return { kind: 'kept', error }
    }
    throw error
  }
  return { kind: 'rotated', reason: 'instance_changed' }
}
