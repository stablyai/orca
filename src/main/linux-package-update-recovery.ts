import { timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  LinuxPackageInstallRecovery,
  LinuxRootPackageType
} from '../shared/update-status-types'
import { getLinuxRootPackageType } from './linux-update-package-type'
import { buildLinuxPackageInstallCommand } from './linux-package-install-command'
import {
  decodeExpectedDigest,
  isContainedInCache,
  streamSha512
} from './updater-artifact-cache-boundary'

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
// Why: the renderer debounces clicks, but the IPC boundary must not allow parallel hashing of a 160 MB package.
const inFlightValidations = new WeakMap<LinuxPackageArtifact, Promise<ValidationResult>>()

export function getTrackedLinuxPackageArtifact(): LinuxPackageArtifact | null {
  return trackedArtifact
}

export function clearTrackedLinuxPackageArtifact(): void {
  trackedArtifact = null
}

/** Clears the artifact only when a different version demonstrably takes over the update cycle. */
export function clearTrackedLinuxPackageArtifactForOtherVersion(version: unknown): void {
  if (!trackedArtifact) {
    return
  }
  // Why: an unknown/empty version is not evidence of another cycle and must not destroy recovery.
  if (typeof version !== 'string' || version.length === 0) {
    return
  }
  if (version === trackedArtifact.version) {
    return
  }
  trackedArtifact = null
}

/**
 * Mirrors electron-updater's cache-name rule: resolve the manifest URL against a dummy base, decode
 * the pathname, require the package extension, and match the basename of the downloaded file.
 * A malformed encoding or an ambiguous file/hash pairing disables cached-package recovery rather
 * than guessing a digest.
 */
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

/**
 * Retains the downloaded package and its release digest so manual actions do not repeat the 160 MB
 * transfer. Only the in-memory event metadata is trusted for the digest.
 */
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
  // Why: a malformed digest can never validate. Arming recovery on it would send the user to the
  // alarming "no longer matches the verified release" path for what is a release-metadata problem.
  if (!sha512 || !decodeExpectedDigest(sha512)) {
    // Why: an unresolvable digest only means THIS event cannot arm recovery. A previously retained
    // artifact carries its own digest and is revalidated on every use, so dropping it would force a
    // needless 160 MB redownload of a file that is still on disk and still verifiable.
    return null
  }
  const artifact = { packageType, version, path: downloadedFile, sha512 }
  trackedArtifact = artifact
  return artifact
}

async function validateArtifact(artifact: LinuxPackageArtifact): Promise<ValidationResult> {
  const expectedDigest = decodeExpectedDigest(artifact.sha512)
  if (!expectedDigest) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  try {
    if (!(await isContainedInCache(artifact.path))) {
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

/** Hashes the exact captured artifact, joining only that capture's in-flight proof. */
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

/**
 * Revalidates the retained package against the digest captured from the release metadata. This is
 * an integrity check against that HTTPS metadata, not a package signature and not a privilege
 * boundary — a same-user process can still replace the file after this returns.
 */
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
