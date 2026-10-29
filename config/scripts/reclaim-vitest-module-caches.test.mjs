import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { reclaimVitestModuleCaches } from './reclaim-vitest-module-caches.mjs'
import { localModuleCacheParent } from './vitest-local-module-cache.mjs'

const roots = []
const nowMs = Date.now()

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function worktreeWithCaches(ages) {
  const worktree = await mkdtemp(join(tmpdir(), 'orca-vitest-module-cache-'))
  roots.push(worktree)
  for (const [name, days] of Object.entries(ages)) {
    const path = join(localModuleCacheParent(worktree), name)
    await mkdir(path, { recursive: true })
    const time = new Date(nowMs - days * 86_400_000)
    await utimes(path, time, time)
  }
  return worktree
}

it('removes only caches idle past the cutoff, and only with --apply', async () => {
  const worktree = await worktreeWithCaches({ idle: 8, recent: 1 })
  const options = { worktrees: [worktree], nowMs, report: () => {} }

  expect(await reclaimVitestModuleCaches(options)).toEqual({ entries: 1 })
  expect((await readdir(localModuleCacheParent(worktree))).sort()).toEqual(['idle', 'recent'])

  await reclaimVitestModuleCaches({ ...options, apply: true })
  expect(await readdir(localModuleCacheParent(worktree))).toEqual(['recent'])
})

it('skips the excluded worktree', async () => {
  const worktree = await worktreeWithCaches({ idle: 8 })
  await reclaimVitestModuleCaches({
    worktrees: [worktree],
    excludeWorktree: worktree,
    apply: true,
    nowMs,
    report: () => {}
  })
  expect(await readdir(localModuleCacheParent(worktree))).toEqual(['idle'])
})
