import { lstatSync, opendirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'

const ROLLOUT_FILE = /^rollout-.*\.jsonl(?:\.zst)?$/
// Live, archived, twins set aside when history was shared, and `<folder>[.<ms>].orca-profile-merge` conflicts.
const HISTORY_FOLDERS = ['sessions', 'archived_sessions', '.orca-set-aside-rollouts']
const MERGE_PENDING_FOLDER = /\.orca-profile-merge$/

export type CodexHistoryDiskUsageBudget = { maxEntries: number; deadline: number }

type Walk = { usage: CodexHistoryDiskUsage; entries: number; budget: CodexHistoryDiskUsageBudget }

/** Absence is an empty folder; anything else unread makes the total a lower bound. */
function noteFailure(walk: Walk, error: unknown): void {
  if (!isDefinitiveAbsence(error)) {
    walk.usage.complete = false
  }
}

function overBudget(walk: Walk): boolean {
  walk.entries += 1
  if (
    walk.entries > walk.budget.maxEntries ||
    (walk.entries % 1024 === 0 && Date.now() > walk.budget.deadline)
  ) {
    walk.usage.complete = false
    return true
  }
  return false
}

function historyFolders(walk: Walk, home: string): string[] {
  const folders = HISTORY_FOLDERS.map((name) => join(home, name))
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && MERGE_PENDING_FOLDER.test(entry.name)) {
        folders.push(join(home, entry.name))
      }
    }
  } catch (error) {
    noteFailure(walk, error)
  }
  return folders
}

/**
 * Sums rollouts in every history folder of the given Codex homes, reading metadata only. Links
 * inside them are never followed, so a symlinked or junctioned log is never read through; a
 * folder that is itself a link (an account home sharing ~/.codex) is resolved and walked once.
 */
export function measureCodexHistoryDiskUsage(
  homes: readonly string[],
  budget: CodexHistoryDiskUsageBudget,
  platform: NodeJS.Platform = process.platform
): CodexHistoryDiskUsage {
  const walk: Walk = { usage: { bytes: 0, rollouts: 0, complete: true }, entries: 0, budget }
  const seenFiles = new Set<string>()
  const seenFolders = new Set<string>()
  const pending: string[] = []
  for (const folder of homes.flatMap((home) => historyFolders(walk, home))) {
    try {
      const real = realpathSync(folder)
      if (!seenFolders.has(real)) {
        seenFolders.add(real)
        pending.push(real)
      }
    } catch (error) {
      noteFailure(walk, error)
    }
  }
  while (pending.length > 0) {
    const dir = pending.pop()!
    let handle
    try {
      handle = opendirSync(dir)
    } catch (error) {
      noteFailure(walk, error)
      continue
    }
    try {
      // Streamed so the budget holds inside one huge folder too.
      for (let child = handle.readSync(); child; child = handle.readSync()) {
        if (overBudget(walk)) {
          return walk.usage
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
        } catch (error) {
          noteFailure(walk, error)
          continue
        }
        // Some filesystems report inode 0 for every file; those count per name.
        const key = stats.ino === 0n ? `path:${path}` : `${stats.dev}:${stats.ino}`
        if (seenFiles.has(key)) {
          continue
        }
        seenFiles.add(key)
        walk.usage.rollouts += 1
        // Allocated blocks are what the disk gives back (APFS compresses many rollouts); Windows reports none.
        walk.usage.bytes += Number(platform === 'win32' ? stats.size : stats.blocks * 512n)
      }
    } catch (error) {
      noteFailure(walk, error)
    } finally {
      handle.closeSync()
    }
  }
  return walk.usage
}
