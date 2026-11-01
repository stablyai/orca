import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { isDevBundleInUse } from './dev-electron-bundle-cache.mjs'

async function git(worktree, args) {
  const result = await runProcess({
    program: 'git',
    args: ['--no-optional-locks', '-C', worktree, ...args],
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024 * 1024,
    terminationBarrier: true
  })
  return result.code === 0 && !result.timedOut ? result.stdout : null
}

// Raw directory mtimes are useless: agent tooling rewrites dot-directories in every worktree.
// Git-visible work and live processes are the signals that a test could be reading a checkout.
export async function worktreeActiveSince(worktree, sinceMs, processTable) {
  if (processTable === null || isDevBundleInUse(worktree, processTable)) {
    return true
  }
  const headTime = await git(worktree, ['log', '-g', '-1', '--format=%ct', 'HEAD'])
  if (headTime === null || Number(headTime.trim()) * 1000 > sinceMs) {
    return true
  }
  const status = await git(worktree, ['status', '--porcelain=v1', '-z', '--no-renames'])
  if (status === null) {
    return true
  }
  for (const entry of status.split('\0')) {
    if (entry.length < 4) {
      continue
    }
    try {
      if ((await lstat(join(worktree, entry.slice(3)))).mtimeMs > sinceMs) {
        return true
      }
    } catch (error) {
      // A deletion has no mtime left to inspect; treat it as unknown recent work.
      if (error.code === 'ENOENT') {
        return true
      }
      throw error
    }
  }
  return false
}
