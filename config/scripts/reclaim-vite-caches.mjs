import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { localRepositoryWorktrees } from './local-repository-worktrees.mjs'
import { isProcessAlive } from './remote-agent-session-process-cleanup.mjs'
import { parseReclaimArguments } from './reclaim-worktree-command.mjs'
import {
  VITE_CACHE_HOST_ID,
  VITE_CACHE_USAGE_DIRECTORY,
  withViteCacheLock
} from './vite-cache-activity.mjs'

const OWNER = /^([\da-f]{64})-([1-9]\d*)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

async function directory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function cacheDirectory(worktree) {
  if (!(await directory(join(worktree, '.cache')))) {
    return null
  }
  const root = join(worktree, '.cache', 'vite')
  return (await directory(root)) ? root : null
}

async function unusedCache(cacheRoot, cutoff, isAlive) {
  try {
    const marker = join(cacheRoot, VITE_CACHE_USAGE_DIRECTORY)
    const info = await lstat(marker)
    if (!info.isDirectory() || info.mtimeMs > cutoff) {
      return false
    }
    for (const name of await readdir(marker)) {
      const match = OWNER.exec(name)
      if (!match || match[1] !== VITE_CACHE_HOST_ID) {
        return false
      }
      const pid = Number(match[2])
      const info = await lstat(join(marker, name))
      if (!Number.isSafeInteger(pid) || !info.isFile() || info.size !== 0 || isAlive(pid)) {
        return false
      }
    }
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function reclaimViteCaches({
  repoRoot = process.cwd(),
  apply = false,
  excludeWorktree,
  minAgeDays = 30,
  nowMs = Date.now(),
  worktrees,
  isAlive = isProcessAlive,
  report = console.log
} = {}) {
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    throw new Error('Vite cache age must be a non-negative number')
  }
  const excluded = excludeWorktree ? await realpath(excludeWorktree) : null
  const roots = worktrees ?? (await localRepositoryWorktrees(repoRoot)).worktrees
  const result = { entries: 0, protected: 0 }
  for (const worktree of new Set(roots)) {
    if (!(await directory(worktree))) {
      continue
    }
    const canonical = await realpath(worktree)
    if (canonical === excluded) {
      continue
    }
    const cacheRoot = await cacheDirectory(canonical)
    if (!cacheRoot) {
      continue
    }
    try {
      await withViteCacheLock(
        cacheRoot,
        async (verify) => {
          if (
            (await cacheDirectory(canonical)) !== cacheRoot ||
            !(await unusedCache(cacheRoot, nowMs - minAgeDays * 86_400_000, isAlive))
          ) {
            result.protected += 1
            return
          }
          verify()
          if (apply) {
            await rm(cacheRoot, { recursive: true, force: true })
          }
          result.entries += 1
          report(`${apply ? 'removed' : 'would remove'} Vite cache ${JSON.stringify(cacheRoot)}`)
        },
        0
      )
    } catch (error) {
      if (error.code !== 'ELOCKED') {
        throw error
      }
      result.protected += 1
    }
  }
  report(
    `${apply ? 'Removed' : 'Would remove'} ${result.entries} Vite cache(s); retained ${result.protected} recent, active, or unverifiable cache(s).`
  )
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseReclaimArguments(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: pnpm reclaim-space [--apply] [--repo DIRECTORY]')
  } else {
    reclaimViteCaches(options).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
