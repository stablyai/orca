import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathInsidePluginRoot } from '../../../shared/plugins/artifacts/plugin-root-containment'

/** Reads plugin files by their real path, refusing any that a symlink takes outside the plugin.
 *  Free of manifest code so the plain-Node check bundle can share it. */

export const PLUGIN_WORKER_ENTRY_MAX_BYTES = 50 * 1024 * 1024

export async function resolveContainedPluginArtifact(
  rootDir: string,
  relativePath: string,
  maxBytes = PLUGIN_WORKER_ENTRY_MAX_BYTES
): Promise<string> {
  const rootReal = await realpath(resolve(rootDir))
  return resolvePathFromRealRoot(rootDir, rootReal, relativePath, 'file', maxBytes)
}

export async function readContainedPluginArtifactText(
  rootDir: string,
  relativePath: string,
  maxBytes: number
): Promise<string> {
  return (await readContainedPluginArtifactBytes(rootDir, relativePath, maxBytes)).toString('utf8')
}

export async function readContainedPluginArtifactBytes(
  rootDir: string,
  relativePath: string,
  maxBytes: number
): Promise<Buffer> {
  const candidate = resolve(rootDir, ...relativePath.split(/[\\/]/))
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<Buffer> => {
    const rootReal = await realpath(resolve(rootDir))
    const before = await lstat(candidate)
    if (before.isSymbolicLink()) {
      throw new Error('is a symbolic link')
    }
    const handle = await open(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      if (expired) {
        throw new Error('artifact read timed out')
      }
      const opened = await handle.stat()
      if (!opened.isFile()) {
        throw new Error('is not a regular file')
      }
      if (opened.size > maxBytes) {
        throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
      }
      // Why: ancestor replacement remains a shared plugin-asset boundary; handle-bound containment needs a repo-wide fix.
      const artifactReal = await realpath(candidate)
      if (!isInsidePluginRoot(rootReal, artifactReal)) {
        throw new Error('resolves outside the plugin directory')
      }
      const after = await stat(artifactReal)
      if (
        opened.dev !== after.dev ||
        opened.ino !== after.ino ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino
      ) {
        throw new Error('changed while opening')
      }
      const chunks: Buffer[] = []
      let total = 0
      while (total <= maxBytes) {
        if (expired) {
          throw new Error('artifact read timed out')
        }
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) {
          break
        }
        chunks.push(chunk.subarray(0, bytesRead))
        total += bytesRead
      }
      if (total > maxBytes) {
        throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
      }
      return Buffer.concat(chunks, total)
    } finally {
      await handle.close()
    }
  }
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new Error('artifact read timed out'))
        }, 5000)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/** Whether a real path lies strictly inside the plugin's real root. */
export function isInsidePluginRoot(rootReal: string, artifactReal: string): boolean {
  return pathInsidePluginRoot(rootReal, artifactReal) !== null
}

export async function resolvePathFromRealRoot(
  rootDir: string,
  rootReal: string,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes?: number
): Promise<string> {
  const artifactReal = await realpath(resolve(rootDir, ...relativePath.split(/[\\/]/)))
  if (!isInsidePluginRoot(rootReal, artifactReal)) {
    throw new Error('resolves outside the plugin directory')
  }
  const artifactStat = await stat(artifactReal)
  if (kind === 'file' && !artifactStat.isFile()) {
    throw new Error('is not a regular file')
  }
  if (kind === 'directory' && !artifactStat.isDirectory()) {
    throw new Error('is not a directory')
  }
  if (kind === 'file' && maxBytes !== undefined && artifactStat.size > maxBytes) {
    throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
  }
  return artifactReal
}
