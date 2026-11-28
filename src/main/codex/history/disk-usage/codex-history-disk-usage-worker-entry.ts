import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import {
  assertOwnedHostCodexManagedHomePath,
  UntrustedManagedCodexHomeError
} from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import type {
  CodexHistoryDiskUsageBudget,
  CodexHistoryDiskUsageWorkerRequest,
  CodexHistoryDiskUsageWorkerResponse
} from './codex-history-disk-usage-worker-protocol'
import { openDirectorySync } from '../../../../shared/open-directory'

// Sync calls on purpose: this file runs only on its worker thread, and per-file async stats would
// cost ~50x more and occupy the libuv pool Electron main shares.

// `.orca-legacy-copy.<attempt>`: an old session copy's own bytes, kept once its name points at the source.
const ROLLOUT_FILE = /^rollout-.*\.jsonl(?:\.zst|\.orca-legacy-copy\.\d+)?$/
// Live, archived, twins set aside when history was shared, and `<folder>[.<ms>].orca-profile-merge` conflicts.
const HISTORY_FOLDERS = ['sessions', 'archived_sessions', '.orca-set-aside-rollouts']
const MERGE_PENDING_FOLDER = /\.orca-profile-merge$/

type Walk = { usage: CodexHistoryDiskUsage; entries: number; maxEntries: number; deadline: number }

/** Absence is an empty folder; anything else unread makes the total a lower bound. */
function noteFailure(walk: Walk, error: unknown): void {
  if (!isDefinitiveAbsence(error)) {
    walk.usage.complete = false
  }
}

function overBudget(walk: Walk): boolean {
  // Every step counts, folders included, so empty or slow folders can't outrun the deadline.
  walk.entries += 1
  if (walk.entries > walk.maxEntries || Date.now() > walk.deadline) {
    walk.usage.complete = false
    return true
  }
  return false
}

/** Home entries count toward the budget too: a home's listing is streamed like any folder. */
function addHistoryFolders(walk: Walk, home: string, folders: string[]): boolean {
  folders.push(...HISTORY_FOLDERS.map((name) => join(home, name)))
  let handle
  try {
    handle = openDirectorySync(home)
  } catch (error) {
    noteFailure(walk, error)
    return true
  }
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (overBudget(walk)) {
        return false
      }
      if (entry.isDirectory() && MERGE_PENDING_FOLDER.test(entry.name)) {
        folders.push(join(home, entry.name))
      }
    }
    return true
  } catch (error) {
    noteFailure(walk, error)
    return true
  } finally {
    handle.closeSync()
  }
}

/** Streams one folder's entries so the budget holds inside a huge folder too. */
function walkFolder(
  walk: Walk,
  dir: string,
  pending: string[],
  seenFiles: Set<string>,
  platform: NodeJS.Platform
): boolean {
  if (overBudget(walk)) {
    return false
  }
  // Queued paths are real paths: one that no longer resolves to itself (it or a parent became a
  // link since it was listed) is not walked through, and the total says "at least".
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) {
    walk.usage.complete = false
    return true
  }
  // Counted only if the folder still resolves to itself afterwards: a parent swapped for a link
  // mid-listing would otherwise send the stats below outside history.
  const found: { key: string; bytes: number }[] = []
  let withinBudget = true
  const handle = openDirectorySync(dir)
  try {
    for (let child = handle.readSync(); child; child = handle.readSync()) {
      // Out of budget mid-folder: stop listing, but keep what this folder already counted.
      if (overBudget(walk)) {
        withinBudget = false
        break
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
      if (!stats.isFile()) {
        continue
      }
      found.push({
        // Some filesystems report inode 0 for every file; those count per name.
        key: stats.ino === 0n ? `path:${path}` : `${stats.dev}:${stats.ino}`,
        // Allocated blocks are what the disk gives back (APFS compresses many rollouts); Windows reports none.
        bytes: Number(platform === 'win32' ? stats.size : stats.blocks * 512n)
      })
    }
  } finally {
    handle.closeSync()
  }
  if (realpathSync(dir) !== dir) {
    walk.usage.complete = false
    return withinBudget
  }
  for (const { key, bytes } of found) {
    if (!seenFiles.has(key)) {
      seenFiles.add(key)
      walk.usage.rollouts += 1
      walk.usage.bytes += bytes
    }
  }
  return withinBudget
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
  const walk: Walk = {
    usage: { bytes: 0, rollouts: 0, complete: true },
    entries: 0,
    maxEntries: budget.maxEntries,
    deadline: Date.now() + budget.timeMs
  }
  const seenFiles = new Set<string>()
  const seenFolders = new Set<string>()
  const pending: string[] = []
  const folders: string[] = []
  // One home can arrive under two spellings (a trailing slash, a link); list each once.
  const seenHomes = new Set<string>()
  for (const home of homes) {
    let real: string
    try {
      real = realpathSync(home)
    } catch (error) {
      noteFailure(walk, error)
      continue
    }
    if (seenHomes.has(real)) {
      continue
    }
    seenHomes.add(real)
    if (!addHistoryFolders(walk, real, folders)) {
      return walk.usage
    }
  }
  for (const folder of folders) {
    if (overBudget(walk)) {
      return walk.usage
    }
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
    try {
      if (!walkFolder(walk, pending.pop()!, pending, seenFiles, platform)) {
        break
      }
    } catch (error) {
      noteFailure(walk, error)
    }
  }
  return walk.usage
}

// Imported without a parent port only by its test.
const port = parentPort
if (port) {
  installWorkerSendLedger('orca-codex-history-disk-usage')
  port.on('message', (request: CodexHistoryDiskUsageWorkerRequest) => {
    let response: CodexHistoryDiskUsageWorkerResponse
    try {
      const accountHomes: string[] = []
      let unreadableAccount = false
      // The deleter's ownership rule (codex-host-rollout-homes), checked here since it reads sync.
      for (const { accountsRoot, accountId } of request.accounts) {
        const home = join(accountsRoot, accountId, 'home')
        try {
          assertOwnedHostCodexManagedHomePath({
            candidatePath: home,
            managedAccountsRoot: accountsRoot,
            systemCodexHomePath: request.systemCodexHomePath,
            expectedAccountId: accountId
          })
          accountHomes.push(home)
        } catch (error) {
          unreadableAccount ||= !(error instanceof UntrustedManagedCodexHomeError)
        }
      }
      const usage = measureCodexHistoryDiskUsage(
        [...request.homes, ...accountHomes],
        request.budget
      )
      response = {
        id: request.id,
        ok: true,
        // An account home that couldn't be checked may hold history this total misses.
        usage: unreadableAccount ? { ...usage, complete: false } : usage
      }
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    port.postMessage(response)
  })
}
