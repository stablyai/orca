// Copied profiles share pairing files; a Mac's hardware identity or ORCA_INSTANCE_ID tells copies apart.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import {
  bestEffortFsyncDirectorySync,
  writeDurableSecureJsonFile
} from '../../shared/secure-storage/secure-file'
import { E2EE_KEYPAIR_FILENAME } from '../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import { writeNewE2EEKeypair } from './rpc/server/pairing/e2ee-keypair'
import { DEVICE_REGISTRY_FILENAME } from './rpc/server/pairing/mobile-pairing-files'
import { HOST_INSTALLATION_FILENAME } from './hosts/platform-probe/host-descriptor'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/access/profile-state-access-identity'

export const HOST_INSTANCE_FILENAME = 'orca-host-instance.json'
export const ORCA_INSTANCE_ID_ENV = 'ORCA_INSTANCE_ID'
const MAX_HOST_INSTANCE_FILE_BYTES = 4 * 1024
const IDENTITY_FILENAMES = [
  E2EE_KEYPAIR_FILENAME,
  DEVICE_REGISTRY_FILENAME,
  HOST_INSTALLATION_FILENAME
] as const
const STAGED_SUFFIX = '.next'
/** Replaced identity files are moved here so an unwanted rotation can be undone by hand. */
export const IDENTITY_BACKUPS_DIRNAME = 'orca-identity-backups'
const MAX_IDENTITY_BACKUPS = 5
const BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/

/** `instanceId` is hashed so the file never republishes a provisioner value. `rotating` is written
 * only once every new file is staged beside the live one; a start that sees it publishes them. */
const HostInstanceMarkerSchema = z.object({
  v: z.literal(1),
  instanceId: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
  rotating: z.literal(true).optional(),
  /** Backup folder for the files a `rotating` publish replaces; stable across an interrupted publish. */
  backup: z.string().optional()
})
type HostInstanceMarker = z.infer<typeof HostInstanceMarkerSchema>

export type HostIdentityOutcome =
  | { kind: 'unchanged' }
  | { kind: 'recorded' }
  | { kind: 'rotated'; reason: 'instance_changed' | 'machine_changed' | 'interrupted_rotation' }
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

function hostMacMachineId(): string | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const machineId = profileStateAccessMachineIdentity()
  return machineId
    ? createHash('sha256').update(`orca-host-machine\0${machineId}`).digest('hex')
    : null
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** `malformed` means a file exists but its contents could not be trusted. */
function readMarkerFile(markerPath: string): {
  marker: HostInstanceMarker | null
  malformed: boolean
} {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return { marker: null, malformed: false }
    }
    throw error
  }
  if (raw.length > MAX_HOST_INSTANCE_FILE_BYTES) {
    return { marker: null, malformed: true }
  }
  try {
    const parsed = HostInstanceMarkerSchema.safeParse(JSON.parse(raw))
    return { marker: parsed.success ? parsed.data : null, malformed: !parsed.success }
  } catch {
    // Writes are atomic, so a bad file was edited by hand; re-record it rather than unpair.
    return { marker: null, malformed: true }
  }
}

function readMarker(markerPath: string): HostInstanceMarker | null {
  return readMarkerFile(markerPath).marker
}

function markerFor(
  instanceId: string | undefined,
  machineId: string | undefined
): HostInstanceMarker {
  return { v: 1, ...(instanceId ? { instanceId } : {}), ...(machineId ? { machineId } : {}) }
}

function newBackupName(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
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
      // A leftover staged file is retried on the next start and never published without `rotating`.
    }
  }
}

/** Best effort: a failed backup must not block the rotation, so the live file is then overwritten. */
function backUpLiveFile(live: string, backupDir: string | null): void {
  if (!backupDir) {
    return
  }
  try {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    const saved = join(backupDir, basename(live))
    // A resumed publish keeps the first backup; a live file recreated meanwhile is not the original.
    if (!existsSync(saved)) {
      renameSync(live, saved)
    }
  } catch {
    // ENOENT: an earlier, interrupted publish already moved it (or it never existed).
  }
}

function pruneIdentityBackups(userDataPath: string, current: string | undefined): void {
  const root = join(userDataPath, IDENTITY_BACKUPS_DIRNAME)
  try {
    // Never the one just made, even when copied-in backups carry later timestamps.
    const names = readdirSync(root)
      .filter((name) => BACKUP_NAME_RE.test(name) && name !== current)
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - (MAX_IDENTITY_BACKUPS - 1)))) {
      rmSync(join(root, name), { recursive: true, force: true })
    }
  } catch {
    // Old backups are only disk space; never fail a rotation over them.
  }
}

/** Moves each staged file over its live file, after moving the live file into the backup folder.
 * Staging finished before the `rotating` marker was written, so a missing staged file was already
 * moved by an earlier, interrupted publish. */
function publishStagedIdentity(
  userDataPath: string,
  marker: Pick<HostInstanceMarker, 'instanceId' | 'machineId' | 'backup'>,
  write: HostIdentityWrite
): void {
  const backupDir =
    marker.backup && BACKUP_NAME_RE.test(marker.backup)
      ? join(userDataPath, IDENTITY_BACKUPS_DIRNAME, marker.backup)
      : null
  for (const { live, staged } of stagedIdentityPaths(userDataPath)) {
    if (!existsSync(staged)) {
      continue
    }
    backUpLiveFile(live, backupDir)
    try {
      renameSync(staged, live)
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
    }
  }
  bestEffortFsyncDirectorySync(userDataPath)
  write(join(userDataPath, HOST_INSTANCE_FILENAME), markerFor(marker.instanceId, marker.machineId))
  pruneIdentityBackups(userDataPath, marker.backup)
}

/**
 * New keypair, no paired devices, new installation id. Callers must hold the profile lock.
 * Without `instanceId` the recorded id is kept, so a manual reset never forgets it.
 * Throws HostIdentityRotationNotStartedError when the old identity is still whole; any other
 * error means the next start must finish the rotation before serving.
 */
export function rotateHostIdentity(
  userDataPath: string,
  instanceId: string | null = hostInstanceIdFromEnv(),
  write: HostIdentityWrite = writeDurableSecureJsonFile,
  now: () => Date = () => new Date()
): void {
  const markerPath = join(userDataPath, HOST_INSTANCE_FILENAME)
  let stored: HostInstanceMarker | null
  try {
    stored = readMarker(markerPath)
  } catch (error) {
    throw new HostIdentityRotationNotStartedError(error)
  }
  const finishedEarlierRotation = !!stored?.rotating
  if (stored?.rotating) {
    // Staging below reuses the `.next` paths, so an earlier rotation must be finished first.
    publishStagedIdentity(userDataPath, stored, write)
  }
  // After finishing an earlier rotation the identity is already new and was never served, which
  // is what a reset asks for; reporting "nothing changed" would be false.
  const notStarted = (error: unknown): void => {
    discardStagedIdentity(userDataPath)
    if (!finishedEarlierRotation) {
      throw new HostIdentityRotationNotStartedError(error)
    }
  }
  const marker: HostInstanceMarker = {
    ...markerFor(instanceId ?? stored?.instanceId, hostMacMachineId() ?? stored?.machineId),
    rotating: true,
    backup: newBackupName(now())
  }
  try {
    stageNewIdentity(userDataPath, write)
  } catch (error) {
    notStarted(error)
    return
  }
  try {
    write(markerPath, marker)
  } catch (error) {
    // The write can fail after its rename (directory sync); a published `rotating` marker
    // needs the staged files, so only discard them once the marker is known not to say so.
    let onDisk: HostInstanceMarker | null
    try {
      onDisk = readMarker(markerPath)
    } catch {
      throw error
    }
    if (!onDisk?.rotating) {
      notStarted(error)
      return
    }
  }
  publishStagedIdentity(userDataPath, marker, write)
}

/**
 * Rotates when a known Mac hardware identity or explicit ORCA_INSTANCE_ID changes.
 * First observations only record their hashes; unavailable identities retain the previous observation.
 * Throws only when a started rotation cannot be finished, so old and new files may be mixed.
 */
export function ensureHostInstanceIdentity(
  userDataPath: string,
  instanceId: string | null = hostInstanceIdFromEnv(),
  write: HostIdentityWrite = writeDurableSecureJsonFile
): HostIdentityOutcome {
  const markerPath = join(userDataPath, HOST_INSTANCE_FILENAME)
  const { marker: stored, malformed } = readMarkerFile(markerPath)
  const machineId = hostMacMachineId()
  const recoveredRotation = !!stored?.rotating
  if (stored?.rotating) {
    // A copied transaction must finish under its original identity before detecting this Mac.
    publishStagedIdentity(userDataPath, stored, write)
  }
  // Without `rotating`, staged files are from a rotation that crashed before its marker; drop
  // them so a secret key does not sit beside the live one until the next rotation. An unreadable
  // marker may have said `rotating`, so its staged files are left for recovery by hand.
  if (!malformed) {
    discardStagedIdentity(userDataPath)
  }
  const instanceChanged = !!instanceId && !!stored?.instanceId && stored.instanceId !== instanceId
  const machineChanged = !!machineId && !!stored?.machineId && stored.machineId !== machineId
  if (
    (!instanceId || stored?.instanceId === instanceId) &&
    (!machineId || stored?.machineId === machineId)
  ) {
    return recoveredRotation
      ? { kind: 'rotated', reason: 'interrupted_rotation' }
      : { kind: 'unchanged' }
  }
  if (!instanceChanged && !machineChanged) {
    try {
      write(markerPath, markerFor(instanceId ?? stored?.instanceId, machineId ?? stored?.machineId))
    } catch (error) {
      return { kind: 'kept', error }
    }
    return recoveredRotation
      ? { kind: 'rotated', reason: 'interrupted_rotation' }
      : { kind: 'recorded' }
  }
  try {
    rotateHostIdentity(userDataPath, instanceId, write)
  } catch (error) {
    if (error instanceof HostIdentityRotationNotStartedError) {
      return { kind: 'kept', error }
    }
    throw error
  }
  return { kind: 'rotated', reason: machineChanged ? 'machine_changed' : 'instance_changed' }
}
