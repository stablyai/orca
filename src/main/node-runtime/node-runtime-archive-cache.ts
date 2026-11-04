import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BUNDLED_NODE_RUNTIME_ARCHIVE_DIRNAME,
  pinnedNodeRuntimeAsset,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'

export function nodeRuntimeArchiveDir(cacheRoot: string): string {
  return join(cacheRoot, 'node', 'archives')
}

export function nodeRuntimeArchiveCachePath(target: NodeRuntimeTarget, cacheRoot: string): string {
  return join(nodeRuntimeArchiveDir(cacheRoot), pinnedNodeRuntimeAsset(target).archive)
}

/** Windows installers ship the pinned Linux archive for their architecture beside the app's resources. */
export function bundledNodeRuntimeArchiveDir(): string | undefined {
  return process.resourcesPath
    ? join(process.resourcesPath, BUNDLED_NODE_RUNTIME_ARCHIVE_DIRNAME)
    : undefined
}

async function sha256Of(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

/**
 * Seed the archive cache from an installer-bundled copy, so a first WSL deploy needs no network.
 * Copied, not linked: the install may be read-only and the upload stage is made beside the cache entry.
 * A missing or mismatched bundle leaves the cache to the normal download path.
 */
export async function seedNodeRuntimeArchiveFromBundle(
  target: NodeRuntimeTarget,
  cacheRoot: string,
  bundledDir: string | undefined
): Promise<void> {
  const asset = pinnedNodeRuntimeAsset(target)
  const cached = nodeRuntimeArchiveCachePath(target, cacheRoot)
  const bundled = bundledDir ? join(bundledDir, asset.archive) : null
  if (!bundled || existsSync(cached) || (await sha256Of(bundled)) !== asset.archiveSha256) {
    return
  }
  await mkdir(dirname(cached), { recursive: true })
  const staged = `${cached}.bundle-${randomUUID()}`
  try {
    await copyFile(bundled, staged)
    if ((await sha256Of(staged)) === asset.archiveSha256) {
      await rename(staged, cached)
    }
  } finally {
    await rm(staged, { force: true })
  }
}
