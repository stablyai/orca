import { timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ServeUpdateSpoolArtifact } from './serve-update-spool'
import {
  decodeExpectedDigest,
  isContainedInCache,
  streamSha512
} from './updater-artifact-cache-boundary'

const APPIMAGE_EXTENSION = '.appimage'

export type ServeUpdateArtifactCapture =
  | { ok: true; artifact: ServeUpdateSpoolArtifact }
  | {
      ok: false
      reason:
        | 'not-appimage'
        | 'missing-metadata'
        | 'missing'
        | 'not-regular'
        | 'hash-mismatch'
        | 'read-failed'
    }

/**
 * Mirrors electron-updater's cache-name rule: resolve each manifest entry URL, require the
 * AppImage extension, and match the basename of the downloaded file. A malformed encoding or
 * an ambiguous file/hash pairing yields no digest rather than a guess.
 */
function resolveExpectedSha512(files: unknown, downloadedFile: string): string | null {
  if (!Array.isArray(files)) {
    return null
  }
  const targetName = path.basename(downloadedFile)
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
    if (!pathname.toLowerCase().endsWith(APPIMAGE_EXTENSION)) {
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
 * Captures the downloaded AppImage and its release digest so the supervised serve install can
 * hand a verified full-bundle artifact to the root helper. The digest comes from the same
 * update-downloaded event electron-updater already verified the download against.
 */
export async function captureServeUpdateAppImage(
  event: unknown
): Promise<ServeUpdateArtifactCapture> {
  const downloadedFile = (event as { downloadedFile?: unknown })?.downloadedFile
  const version = (event as { version?: unknown })?.version
  if (typeof downloadedFile !== 'string' || !path.isAbsolute(downloadedFile)) {
    return { ok: false, reason: 'missing-metadata' }
  }
  if (!downloadedFile.toLowerCase().endsWith(APPIMAGE_EXTENSION)) {
    return { ok: false, reason: 'not-appimage' }
  }
  if (typeof version !== 'string' || version.length === 0) {
    return { ok: false, reason: 'missing-metadata' }
  }
  const expected = decodeExpectedDigest(
    resolveExpectedSha512((event as { files?: unknown })?.files, downloadedFile) ?? ''
  )
  if (!expected) {
    return { ok: false, reason: 'missing-metadata' }
  }
  try {
    if (!(await isContainedInCache(downloadedFile))) {
      return { ok: false, reason: 'not-regular' }
    }
    const stats = await fsp.lstat(downloadedFile)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { ok: false, reason: 'not-regular' }
    }
    const actualDigest = await streamSha512(downloadedFile)
    if (
      actualDigest.byteLength !== expected.byteLength ||
      !timingSafeEqual(actualDigest, expected)
    ) {
      return { ok: false, reason: 'hash-mismatch' }
    }
    return {
      ok: true,
      artifact: {
        artifactPath: downloadedFile,
        sha512: expected.toString('base64'),
        targetVersion: version
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'read-failed' }
  }
}
