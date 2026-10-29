import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  LinuxPackageInstallRecovery,
  LinuxRootPackageType
} from '../shared/update-status-types'
import { getLinuxRootPackageType } from './linux-update-package-type'
import { buildLinuxPackageInstallCommand } from './linux-package-install-command'

const SHA512_BYTE_LENGTH = 64
const PENDING_DIRECTORY_NAME = 'pending'

export type LinuxPackageArtifact = {
  packageType: LinuxRootPackageType
  version: string
  path: string
  sha512: string
}

export type LinuxPackageRecoveryUnavailableReason =
  | 'missing'
  | 'not-regular'
  | 'hash-mismatch'
  | 'no-sudo'
  | 'no-package-manager'
  | 'invalid-package-path'
  | 'read-failed'

export type LinuxPackageInstructionsResult =
  | { ok: true; command: string; packageFileName: string }
  | { ok: false; reason: LinuxPackageRecoveryUnavailableReason }

export type LinuxPackageRevealResult =
  | { ok: true; path: string }
  | { ok: false; reason: LinuxPackageRecoveryUnavailableReason }

type ValidationResult =
  | { ok: true; artifact: LinuxPackageArtifact }
  | { ok: false; reason: 'missing' | 'not-regular' | 'hash-mismatch' | 'read-failed' }

let trackedArtifact: LinuxPackageArtifact | null = null
// Deduplicate hashing at the IPC boundary even if clients debounce clicks.
const inFlightValidations = new WeakMap<LinuxPackageArtifact, Promise<ValidationResult>>()

export function getTrackedLinuxPackageArtifact(): LinuxPackageArtifact | null {
  return trackedArtifact
}

export function clearTrackedLinuxPackageArtifact(): void {
  trackedArtifact = null
}

export function clearTrackedLinuxPackageArtifactForOtherVersion(version: unknown): void {
  if (!trackedArtifact) {
    return
  }
  // Missing version metadata does not prove another update cycle has started.
  if (typeof version !== 'string' || version.length === 0) {
    return
  }
  if (version === trackedArtifact.version) {
    return
  }
  trackedArtifact = null
}

/** Match electron-updater’s decoded cache filename; reject malformed or conflicting digests. */
function resolveExpectedSha512(
  files: unknown,
  downloadedFile: string,
  packageType: LinuxRootPackageType
): string | null {
  if (!Array.isArray(files)) {
    return null
  }
  const targetName = path.basename(downloadedFile)
  const extension = `.${packageType}`
  let resolved: string | null = null
  for (const entry of files) {
    const url = (entry as { url?: unknown })?.url
    if (typeof url !== 'string' || url.length === 0) {
      continue
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(url, 'http://update-file-name.invalid/').pathname)
    } catch {
      return null
    }
    if (!pathname.toLowerCase().endsWith(extension)) {
      continue
    }
    if (path.posix.basename(pathname) !== targetName) {
      continue
    }
    const sha512 = (entry as { sha512?: unknown })?.sha512
    if (typeof sha512 !== 'string' || sha512.length === 0) {
      return null
    }
    if (resolved !== null && resolved !== sha512) {
      return null
    }
    resolved = sha512
  }
  return resolved
}

/** Trust only the release event’s digest; retain the download for manual recovery. */
export function captureLinuxPackageArtifact(event: unknown): LinuxPackageArtifact | null {
  const packageType = getLinuxRootPackageType()
  if (!packageType) {
    return null
  }
  const downloadedFile = (event as { downloadedFile?: unknown })?.downloadedFile
  const version = (event as { version?: unknown })?.version
  if (typeof downloadedFile !== 'string' || !path.isAbsolute(downloadedFile)) {
    return null
  }
  if (!downloadedFile.toLowerCase().endsWith(`.${packageType}`)) {
    return null
  }
  if (typeof version !== 'string' || version.length === 0) {
    return null
  }
  const sha512 = resolveExpectedSha512(
    (event as { files?: unknown })?.files,
    downloadedFile,
    packageType
  )
  // Reject malformed release metadata before offering recovery that cannot validate.
  if (!sha512 || !decodeExpectedDigest(sha512)) {
    // Keep the prior artifact: it has its own digest and is revalidated on use.
    return null
  }
  const artifact = { packageType, version, path: downloadedFile, sha512 }
  trackedArtifact = artifact
  return artifact
}

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function getUpdaterCacheRoot(): string {
  // Match electron-updater’s XDG_CACHE_HOME handling, including relative paths.
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
}

/** Anchor paths under the real cache root to exclude other users’ swap locations; same-user writes remain possible. */
export async function isInUpdaterPendingCache(filePath: string): Promise<boolean> {
  const cacheRoot = path.resolve(getUpdaterCacheRoot())
  if (!isInsideDirectory(cacheRoot, path.resolve(filePath))) {
    return false
  }
  const realCacheRoot = path.resolve(await fsp.realpath(cacheRoot))
  const realParent = path.resolve(await fsp.realpath(path.dirname(filePath)))
  if (!isInsideDirectory(realCacheRoot, path.join(realParent, path.basename(filePath)))) {
    return false
  }
  if (path.basename(realParent) !== PENDING_DIRECTORY_NAME) {
    return false
  }
  // The updater cache directory sits directly under the cache root, so `pending` is exactly two down.
  return path.dirname(path.dirname(realParent)) === realCacheRoot
}

function decodeExpectedDigest(sha512: string): Buffer | null {
  const trimmed = sha512.trim()
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.byteLength !== SHA512_BYTE_LENGTH) {
    return null
  }
  // Round-trip standard base64: Buffer.from silently accepts malformed input.
  return decoded.toString('base64') === trimmed ? decoded : null
}

function streamSha512(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest()))
  })
}

async function validateArtifact(artifact: LinuxPackageArtifact): Promise<ValidationResult> {
  const expectedDigest = decodeExpectedDigest(artifact.sha512)
  if (!expectedDigest) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  try {
    if (!(await isInUpdaterPendingCache(artifact.path))) {
      return { ok: false, reason: 'not-regular' }
    }
    const stats = await fsp.lstat(artifact.path)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { ok: false, reason: 'not-regular' }
    }
    const actualDigest = await streamSha512(artifact.path)
    if (
      actualDigest.byteLength !== expectedDigest.byteLength ||
      !timingSafeEqual(actualDigest, expectedDigest)
    ) {
      return { ok: false, reason: 'hash-mismatch' }
    }
    return { ok: true, artifact }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'read-failed' }
  }
}

function runValidation(artifact: LinuxPackageArtifact): Promise<ValidationResult> {
  const inFlight = inFlightValidations.get(artifact)
  if (inFlight) {
    return inFlight
  }
  const promise: Promise<ValidationResult> = validateArtifact(artifact).finally(() => {
    if (inFlightValidations.get(artifact) === promise) {
      inFlightValidations.delete(artifact)
    }
  })
  inFlightValidations.set(artifact, promise)
  return promise
}

/** Release-metadata integrity only; a same-user process can still replace the file after validation. */
async function validateTrackedArtifact(
  recovery: LinuxPackageInstallRecovery
): Promise<ValidationResult> {
  const artifact = trackedArtifact
  if (
    !artifact ||
    artifact.version !== recovery.version ||
    artifact.packageType !== recovery.packageType
  ) {
    return { ok: false, reason: 'missing' }
  }
  return runValidation(artifact)
}

export async function resolveLinuxPackageInstallInstructions(
  recovery: LinuxPackageInstallRecovery
): Promise<LinuxPackageInstructionsResult> {
  const validation = await validateTrackedArtifact(recovery)
  if (!validation.ok) {
    return validation
  }
  const { artifact } = validation
  const command = buildLinuxPackageInstallCommand(artifact.packageType, artifact.path)
  if (!command.ok) {
    return command
  }
  return {
    ok: true,
    command: command.command,
    packageFileName: path.basename(artifact.path)
  }
}

export async function resolveLinuxPackageRevealTarget(
  recovery: LinuxPackageInstallRecovery
): Promise<LinuxPackageRevealResult> {
  const validation = await validateTrackedArtifact(recovery)
  if (!validation.ok) {
    return validation
  }
  return { ok: true, path: validation.artifact.path }
}
