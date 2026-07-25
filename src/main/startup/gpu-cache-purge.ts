import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Chromium GPU/shader caches under userData.
 *
 * A cache written by the driver that just CHECK-crashed is replayed on the next
 * GPU init, so escalating the fallback tier without purging can reproduce the
 * same crash on a launch that should have been safe.
 */
export const GPU_CACHE_DIRECTORY_NAMES = [
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache'
] as const

export type GpuCachePurgeResult = {
  removed: string[]
  failed: string[]
}

/** Best effort: a locked cache directory must never block the relaunch that follows. */
export function purgeGpuCaches(userDataPath: string): GpuCachePurgeResult {
  const removed: string[] = []
  const failed: string[] = []
  for (const name of GPU_CACHE_DIRECTORY_NAMES) {
    const target = join(userDataPath, name)
    try {
      if (!existsSync(target)) {
        continue
      }
      // Why: Windows can hold a brief lock on a cache file the dying GPU child owned.
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
      removed.push(name)
    } catch {
      failed.push(name)
    }
  }
  return { removed, failed }
}
