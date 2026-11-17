import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'

const ROLLOUT_FILE = /^rollout-.*\.jsonl(?:\.zst)?$/

export type CodexHistoryDiskUsageBudget = { maxEntries: number; deadline: number }

/**
 * Sums rollouts under the given history folders. Links inside them are never followed, so a
 * symlinked or junctioned log is never read through; a root that is itself a link (an account
 * home sharing ~/.codex) is resolved once and walked once.
 */
export function measureCodexHistoryDiskUsage(
  roots: readonly string[],
  budget: CodexHistoryDiskUsageBudget,
  platform: NodeJS.Platform = process.platform
): CodexHistoryDiskUsage {
  const seenFiles = new Set<string>()
  const seenRoots = new Set<string>()
  const usage: CodexHistoryDiskUsage = { bytes: 0, rollouts: 0, complete: true }
  let entries = 0
  const pending: string[] = []
  for (const root of roots) {
    let real: string
    try {
      real = realpathSync(root)
    } catch {
      continue
    }
    if (!seenRoots.has(real)) {
      seenRoots.add(real)
      pending.push(real)
    }
  }
  while (pending.length > 0) {
    const dir = pending.pop()!
    let children
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      entries += 1
      if (entries > budget.maxEntries || (entries % 1024 === 0 && Date.now() > budget.deadline)) {
        usage.complete = false
        return usage
      }
      const path = join(dir, child.name)
      if (child.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!child.isFile() || !ROLLOUT_FILE.test(child.name)) {
        continue
      }
      let stats
      try {
        stats = lstatSync(path, { bigint: true })
      } catch {
        continue
      }
      // Some filesystems report inode 0 for every file; those count per name.
      const key = stats.ino === 0n ? `path:${path}` : `${stats.dev}:${stats.ino}`
      if (seenFiles.has(key)) {
        continue
      }
      seenFiles.add(key)
      usage.rollouts += 1
      // Allocated blocks are what the disk gives back (APFS compresses many rollouts); Windows has none.
      usage.bytes += Number(
        platform === 'win32' || stats.blocks === 0n ? stats.size : stats.blocks * 512n
      )
    }
  }
  return usage
}
