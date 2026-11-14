import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
  const artifact = await resolveContainedPluginArtifact(rootDir, relativePath, maxBytes)
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of createReadStream(artifact)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += bytes.byteLength
    if (totalBytes > maxBytes) {
      throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, totalBytes)
}

export async function resolvePathFromRealRoot(
  rootDir: string,
  rootReal: string,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes?: number
): Promise<string> {
  const artifactReal = await realpath(resolve(rootDir, ...relativePath.split(/[\\/]/)))
  const fromRoot = relative(rootReal, artifactReal)
  if (
    fromRoot.length === 0 ||
    isAbsolute(fromRoot) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`)
  ) {
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
