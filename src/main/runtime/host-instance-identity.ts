// Copies of one machine image share the pairing identity files; ORCA_INSTANCE_ID tells the copies apart.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { writeNewE2EEKeypair } from './e2ee-keypair'
import { DEVICE_REGISTRY_FILENAME } from './rpc/server/pairing/mobile-pairing-files'
import { HOST_INSTALLATION_FILENAME } from './hosts/platform-probe/host-descriptor'

export const HOST_INSTANCE_FILENAME = 'orca-host-instance.json'
export const ORCA_INSTANCE_ID_ENV = 'ORCA_INSTANCE_ID'
const MAX_HOST_INSTANCE_FILE_BYTES = 4 * 1024

/** `instanceId` is hashed so the file never republishes a provisioner value. `rotating` marks a
 * rotation that started; whichever start sees it finishes the rotation before serving. */
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

export type HostIdentityWrite = (path: string, value: unknown) => boolean

export function hostInstanceIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ORCA_INSTANCE_ID_ENV]?.trim()
  return raw ? createHash('sha256').update(`orca-host-instance\0${raw}`).digest('hex') : null
}

function readMarker(markerPath: string): HostInstanceMarker | null {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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

/** Each file is replaced by an atomic rename; the `rotating` marker covers a crash between files. */
function finishRotation(
  userDataPath: string,
  instanceId: string | undefined,
  write: HostIdentityWrite
): void {
  writeNewE2EEKeypair(userDataPath, write)
  write(join(userDataPath, DEVICE_REGISTRY_FILENAME), [])
  write(join(userDataPath, HOST_INSTALLATION_FILENAME), { installationId: randomUUID() })
  write(join(userDataPath, HOST_INSTANCE_FILENAME), markerFor(instanceId))
}

/** New keypair, no paired devices, new installation id. Callers must hold the profile lock. */
export function rotateHostIdentity(
  userDataPath: string,
  instanceId: string | null = hostInstanceIdFromEnv(),
  write: HostIdentityWrite = writeDurableSecureJsonFile
): void {
  write(join(userDataPath, HOST_INSTANCE_FILENAME), markerFor(instanceId ?? undefined, true))
  finishRotation(userDataPath, instanceId ?? undefined, write)
}

/**
 * Rotates only when ORCA_INSTANCE_ID is set and differs from the id recorded with this identity.
 * Unset never rotates; the first id seen is recorded so adopting the variable keeps pairings.
 */
export function ensureHostInstanceIdentity(
  userDataPath: string,
  instanceId: string | null = hostInstanceIdFromEnv(),
  write: HostIdentityWrite = writeDurableSecureJsonFile
): HostIdentityOutcome {
  const markerPath = join(userDataPath, HOST_INSTANCE_FILENAME)
  const stored = readMarker(markerPath)
  if (stored?.rotating) {
    finishRotation(userDataPath, instanceId ?? stored.instanceId, write)
    return { kind: 'rotated', reason: 'interrupted_rotation' }
  }
  if (!instanceId || stored?.instanceId === instanceId) {
    return { kind: 'unchanged' }
  }
  if (!stored?.instanceId) {
    write(markerPath, markerFor(instanceId))
    return { kind: 'recorded' }
  }
  rotateHostIdentity(userDataPath, instanceId, write)
  return { kind: 'rotated', reason: 'instance_changed' }
}
