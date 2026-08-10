import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { LinuxPackageInstallRecovery, LinuxRootPackageType } from '../shared/types'
import { getLinuxRootPackageType } from './linux-update-package-type'
import { buildLinuxPackageInstallCommand } from './linux-package-install-command'

const SHA512_BYTE_LENGTH = 64
// electron-updater downloads into <cacheRoot>/<updaterCacheDirName>/pending; nothing else is trusted.
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
  | { ok: true }
  | { ok: false; reason: LinuxPackageRecoveryUnavailableReason }

type ValidationResult =
  | { ok: true; artifact: LinuxPackageArtifact }
  | { ok: false; reason: 'missing' | 'not-regular' | 'hash-mismatch' | 'read-failed' }

let trackedArtifact: LinuxPackageArtifact | null = null
// Why: the renderer debounces clicks, but the IPC boundary must not allow parallel hashing of a 160 MB package.
let inFlightValidation: { key: string; promise: Promise<ValidationResult> } | null = null

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
 * Retains the verified download so a failed root-package install stays recoverable without paying
 * for the 160 MB transfer again. Only the in-memory event metadata is trusted for the digest.
 */
export function captureLinuxPackageArtifact(event: unknown): void {
  const packageType = getLinuxRootPackageType()
  if (!packageType) {
    return
  }
  const downloadedFile = (event as { downloadedFile?: unknown })?.downloadedFile
  const version = (event as { version?: unknown })?.version
  if (typeof downloadedFile !== 'string' || !path.isAbsolute(downloadedFile)) {
    return
  }
  if (!downloadedFile.toLowerCase().endsWith(`.${packageType}`)) {
    return
  }
  if (typeof version !== 'string' || version.length === 0) {
    return
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
    return
  }
  trackedArtifact = { packageType, version, path: downloadedFile, sha512 }
}

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The cache root electron-updater downloads into. Mirrors its own `getAppCacheDir()` rule, which on
 * Linux resolves to the same directory Electron reports as the `cache` path.
 */
function getUpdaterCacheRoot(): string {
  // Mirrors upstream exactly, including its lack of an absoluteness check — diverging here would put
  // the real download outside the directory this module treats as the cache.
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
}

/**
 * Rejects traversal and a symlinked parent that escapes the updater cache.
 *
 * The security boundary is the cache-root anchor below: electron-updater builds `downloadedFile` from
 * the `fileName` in the cache's own writable `update-info.json` without calling `basename`, so without
 * it a manipulated entry could point at `/tmp` or `/dev/shm` where a DIFFERENT principal can win the
 * swap race. The `<cacheRoot>/<updaterCacheDirName>/pending` shape check narrows the accepted paths to
 * the one place electron-updater actually downloads into; it is defence in depth, not a boundary — a
 * same-uid process can create its own `pending` directory, and per the design's trust model such a
 * process can already overwrite the real cached package anyway.
 */
async function isContainedInCache(filePath: string): Promise<boolean> {
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
  // Why: Buffer.from silently drops invalid base64 characters; round-tripping rejects malformed input.
  // The round-trip emits standard base64, so a URL-safe digest would be rejected — electron-updater's
  // latest-linux.yml is standard base64, and failing closed on an unrecognized encoding is correct.
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

/**
 * Hashes the artifact, joining an identical pass already in flight. `fresh` opts out of that reuse:
 * a verdict that reaches a root installer must cover the bytes as of this call, not as of whenever
 * some earlier Copy/Show click started streaming.
 */
function runValidation(
  artifact: LinuxPackageArtifact,
  options?: { fresh?: boolean }
): Promise<ValidationResult> {
  const key = `${artifact.packageType}:${artifact.version}:${artifact.path}:${artifact.sha512}`
  if (!options?.fresh && inFlightValidation?.key === key) {
    return inFlightValidation.promise
  }
  const promise: Promise<ValidationResult> = validateArtifact(artifact).finally(() => {
    // Why: identity, not key — a fresh install pass may already have replaced this entry.
    if (inFlightValidation?.promise === promise) {
      inFlightValidation = null
    }
  })
  inFlightValidation = { key, promise }
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

/**
 * Re-proves the retained package immediately before the privileged installer consumes it.
 *
 * The cache path is user-writable, so a digest checked when the download finished says nothing
 * about the bytes `dpkg -i` will read minutes later. Re-hashing here does not close the race —
 * only an immutable handoff would — but it shrinks the window from "since the download" to
 * "since this call", and it catches the artifact being swapped or deleted outright. Takes the
 * artifact rather than a recovery so both the retry and the plain "Restart to Update" install
 * are covered.
 */
export async function revalidateLinuxPackageForInstall(
  artifact: LinuxPackageArtifact
): Promise<{ ok: true } | { ok: false; reason: LinuxPackageRecoveryUnavailableReason }> {
  const validation = await runValidation(artifact, { fresh: true })
  return validation.ok ? { ok: true } : { ok: false, reason: validation.reason }
}

export async function revealLinuxPackage(
  recovery: LinuxPackageInstallRecovery
): Promise<LinuxPackageRevealResult> {
  const validation = await validateTrackedArtifact(recovery)
  if (!validation.ok) {
    return validation
  }
  // Why: this cache path must not travel through the workspace shell:openPath API, whose execution
  // host can be an SSH or WSL machine rather than the one that owns the installed package.
  try {
    shell.showItemInFolder(validation.artifact.path)
  } catch {
    // Why: every other failure in this module reports through {ok:false}; a raw throw here would
    // reject the IPC with an unredacted message and skip the lifecycle record.
    return { ok: false, reason: 'read-failed' }
  }
  return { ok: true }
}
