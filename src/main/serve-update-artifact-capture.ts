import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ServeUpdateSpoolArtifact } from './serve-update-spool'

const SHA512_BYTE_LENGTH = 64
// electron-updater downloads into <cacheRoot>/<updaterCacheDirName>/pending; nothing else is trusted.
const PENDING_DIRECTORY_NAME = 'pending'
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

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The cache root electron-updater downloads into. Mirrors its own `getAppCacheDir()` rule,
 * which on Linux resolves to the same directory Electron reports as the `cache` path.
 */
function getUpdaterCacheRoot(): string {
  // Mirrors upstream exactly, including its lack of an absoluteness check — diverging here would put
  // the real download outside the directory this module treats as the cache.
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
}

/**
 * Rejects traversal and a symlinked parent that escapes the updater cache. Same boundary as
 * `linux-package-update-recovery.isContainedInCache`: the `<cacheRoot>/<updaterCacheDirName>/pending`
 * shape check narrows the accepted paths to the one place electron-updater actually downloads into.
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
