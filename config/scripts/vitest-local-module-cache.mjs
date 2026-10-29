import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

// A run that started under an older policy may still be reading its directory.
const STALE_AFTER_MS = 30 * 60_000

export function localModuleCacheParent(root) {
  return join(root, 'node_modules', '.cache', 'orca-vitest-modules')
}

/** Retire directories from earlier policies so one worktree holds a single cache. */
export function pruneLocalModuleCaches(parent, keep, now = Date.now()) {
  let names
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(parent, name)
    try {
      if (name !== keep && now - statSync(path).mtimeMs > STALE_AFTER_MS) {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 })
      }
    } catch {}
  }
}

/**
 * Persist Vitest transforms between local runs. The policy hash covers what Vitest's
 * per-module key misses (lockfile, tsconfig, package.json, runner scripts), so any such
 * change starts a fresh directory. CI keeps its own shard-keyed cache.
 */
export async function localModuleCacheEnv(root, env = process.env) {
  if (env.CI || env.ORCA_UNIT_MODULE_CACHE_PATH || env.ORCA_LOCAL_MODULE_CACHE === '0') {
    return {}
  }
  const parent = localModuleCacheParent(root)
  // Lazy: the policy hash loads TypeScript sources that reclaim, which only needs the parent, avoids.
  const { moduleCachePolicyHash } = await import('./ci-unit-module-cache.mjs')
  const key = `${(await moduleCachePolicyHash(root)).slice(0, 16)}-node${process.versions.node}`
  pruneLocalModuleCaches(parent, key)
  const path = join(parent, key)
  // Reclaim (reclaim-vitest-module-caches.mjs) reads this mtime as the last run.
  mkdirSync(path, { recursive: true })
  const now = new Date()
  utimesSync(path, now, now)
  return { ORCA_UNIT_MODULE_CACHE_PATH: path }
}
