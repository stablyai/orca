import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SHA512_BYTE_LENGTH = 64
// electron-updater downloads into <cacheRoot>/<updaterCacheDirName>/pending; nothing else is trusted.
const PENDING_DIRECTORY_NAME = 'pending'

export function isInsideDirectory(root: string, target: string): boolean {
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
export async function isContainedInCache(filePath: string): Promise<boolean> {
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

export function decodeExpectedDigest(sha512: string): Buffer | null {
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

export function streamSha512(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest()))
  })
}
