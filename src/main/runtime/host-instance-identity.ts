// Snapshot/image clones copy the pairing identity files; ORCA_INSTANCE_ID lets an operator bind them to one instance.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { E2EE_KEYPAIR_FILENAME } from '../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import { DEVICE_REGISTRY_FILENAME } from './rpc/server/pairing/mobile-pairing-files'
import { HOST_INSTALLATION_FILENAME } from './hosts/platform-probe/host-descriptor'

export const HOST_INSTANCE_FILENAME = 'orca-host-instance.json'
export const ORCA_INSTANCE_ID_ENV = 'ORCA_INSTANCE_ID'
export const HOST_IDENTITY_BACKUP_PREFIX = 'orca-host-identity-backup-'
const MAX_HOST_INSTANCE_FILE_BYTES = 4 * 1024

/** A clone must not keep any of these: they are what paired clients trust. */
const PAIRING_IDENTITY_FILENAMES = [
  E2EE_KEYPAIR_FILENAME,
  DEVICE_REGISTRY_FILENAME,
  HOST_INSTALLATION_FILENAME
] as const

export type HostInstanceVerdict =
  | { kind: 'disabled' }
  | { kind: 'recorded' }
  | { kind: 'unchanged' }
  | { kind: 'unverified' }
  | { kind: 'rotated'; backupDir: string }

const HostInstanceMarkerSchema = z.object({ v: z.literal(1), instanceId: z.string().min(1) })

type MarkerRead =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'valid'; instanceId: string }

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

// Hashed so the marker never republishes a provisioner-chosen value.
function fingerprint(value: string): string {
  return createHash('sha256').update(`orca-host-instance\0${value}`).digest('hex')
}

function readMarker(markerPath: string): MarkerRead {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error }
  }
  if (raw.length > MAX_HOST_INSTANCE_FILE_BYTES) {
    return { kind: 'corrupt' }
  }
  try {
    const parsed = HostInstanceMarkerSchema.safeParse(JSON.parse(raw))
    return parsed.success
      ? { kind: 'valid', instanceId: parsed.data.instanceId }
      : { kind: 'corrupt' }
  } catch {
    return { kind: 'corrupt' }
  }
}

function moveIdentityAside(userDataPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const backupDir = join(userDataPath, `${HOST_IDENTITY_BACKUP_PREFIX}${stamp}-${process.pid}`)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  for (const filename of PAIRING_IDENTITY_FILENAMES) {
    try {
      renameSync(join(userDataPath, filename), join(backupDir, filename))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error
      }
    }
  }
  return backupDir
}

/**
 * Moves the pairing identity aside when ORCA_INSTANCE_ID differs from the one recorded in this data
 * directory. Without the env var this does nothing. Throws only when a rotation it has decided on
 * cannot complete, so callers can refuse to serve the copied identity.
 */
export function ensureHostInstanceIdentity(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): HostInstanceVerdict {
  const rawInstanceId = env[ORCA_INSTANCE_ID_ENV]?.trim()
  if (!rawInstanceId) {
    return { kind: 'disabled' }
  }
  const instanceId = fingerprint(rawInstanceId)
  const markerPath = join(userDataPath, HOST_INSTANCE_FILENAME)
  const stored = readMarker(markerPath)

  if (stored.kind === 'valid' && stored.instanceId === instanceId) {
    return { kind: 'unchanged' }
  }
  if (stored.kind === 'unreadable') {
    // No evidence of a clone; destroying identity on an I/O error would unpair a host that never moved.
    console.warn(
      `[runtime] Could not read ${HOST_INSTANCE_FILENAME}; keeping the current pairing identity ` +
        `without checking ${ORCA_INSTANCE_ID_ENV}:`,
      stored.error
    )
    return { kind: 'unverified' }
  }
  if (stored.kind === 'missing' || stored.kind === 'corrupt') {
    if (stored.kind === 'corrupt') {
      console.warn(
        `[runtime] ${HOST_INSTANCE_FILENAME} was malformed; recording ${ORCA_INSTANCE_ID_ENV} ` +
          'again and keeping the current pairing identity.'
      )
    }
    try {
      writeSecureJsonFile(markerPath, { v: 1, instanceId })
    } catch (error) {
      console.warn(`[runtime] Could not record ${ORCA_INSTANCE_ID_ENV}:`, error)
      return { kind: 'unverified' }
    }
    return { kind: 'recorded' }
  }

  const backupDir = moveIdentityAside(userDataPath, now)
  // Written last: if this fails the next start rotates again rather than serving the copy.
  writeSecureJsonFile(markerPath, { v: 1, instanceId })
  console.warn(
    `[runtime] ${ORCA_INSTANCE_ID_ENV} changed since this data directory was last used, so it was ` +
      'probably copied from another machine or snapshot. Moved the E2EE keypair, paired devices and ' +
      `host installation id to ${backupDir} and created a new identity. Pair clients with this host again.`
  )
  return { kind: 'rotated', backupDir }
}
