import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { localRepositoryWorktrees } from './local-repository-worktrees.mjs'
import { parseReclaimArguments } from './reclaim-worktree-command.mjs'
import { localModuleCacheParent } from './vitest-local-module-cache.mjs'

// Each run touches its directory, so an mtime this old means no recent test run used it.
export const VITEST_MODULE_CACHE_MIN_AGE_DAYS = 7

export async function reclaimVitestModuleCaches({
  repoRoot = process.cwd(),
  apply = false,
  excludeWorktree,
  minAgeDays = VITEST_MODULE_CACHE_MIN_AGE_DAYS,
  nowMs = Date.now(),
  worktrees,
  report = console.log
} = {}) {
  const excluded = excludeWorktree ? await realpath(excludeWorktree).catch(() => null) : null
  const roots = worktrees ?? (await localRepositoryWorktrees(repoRoot)).worktrees
  const cutoff = nowMs - minAgeDays * 86_400_000
  let removed = 0
  for (const worktree of new Set(roots)) {
    const canonical = await realpath(worktree).catch(() => null)
    if (!canonical || canonical === excluded) {
      continue
    }
    const parent = localModuleCacheParent(canonical)
    const names = await readdir(parent).catch(() => [])
    for (const name of names) {
      const path = join(parent, name)
      const info = await lstat(path).catch(() => null)
      if (!info?.isDirectory() || info.mtimeMs > cutoff) {
        continue
      }
      if (apply) {
        await rm(path, { recursive: true, force: true, maxRetries: 3 })
      }
      removed += 1
      report(`${apply ? 'removed' : 'would remove'} Vitest module cache ${JSON.stringify(path)}`)
    }
  }
  report(
    `${apply ? 'Removed' : 'Would remove'} ${removed} Vitest module cache(s) idle for ${minAgeDays}+ days.`
  )
  return { entries: removed }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseReclaimArguments(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: pnpm reclaim-space [--apply] [--repo DIRECTORY]')
  } else {
    reclaimVitestModuleCaches(options).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
