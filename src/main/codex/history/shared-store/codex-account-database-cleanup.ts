import type { BigIntStats } from 'node:fs'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import type { CodexHistoryCleanupMode } from '../cleanup-policy/codex-history-cleanup-policy'
import {
  fromManifestPath,
  sameFacts,
  type FileFacts
} from './codex-account-history-cleanup-manifest'
import { DAY_MS, databasesUnused } from './codex-account-history-delete-guards'
import {
  currentLeftBehindFile,
  databaseGroup,
  freedBy,
  isLeftBehindPath
} from './codex-account-left-behind-paths'
import type { CleanupKindTally } from './codex-history-cleanup-sweep-tally'

type DatabaseGroup = { files: FileFacts[]; stats: BigIntStats[] }

// Groups old enough, with no stray WAL or SHM and no second name: only these are worth asking the
// open-file check about. Each pass records the files afresh, so only their age shows nothing has
// opened them since.
export async function eligibleDatabaseGroups(args: {
  home: string
  databases: FileFacts[]
  now: number
  minUnchangedDays: number
  shouldStop: () => boolean
}): Promise<DatabaseGroup[]> {
  const groups = new Map<string, FileFacts[]>()
  for (const database of args.databases) {
    if (isLeftBehindPath(database.path, 'database')) {
      const group = databaseGroup(database.path)
      groups.set(group, [...(groups.get(group) ?? []), database])
    }
  }
  const untouchedSince = args.now - args.minUnchangedDays * DAY_MS
  const eligible: DatabaseGroup[] = []
  for (const [group, files] of groups) {
    if (args.shouldStop()) {
      return []
    }
    try {
      const recorded = new Set(files.map((file) => file.path))
      const unrecorded = await Promise.all(
        [group, `${group}-wal`, `${group}-shm`]
          .filter((path) => !recorded.has(path))
          .map((path) => lstatIfPresent(fromManifestPath(args.home, path)))
      )
      const current = await Promise.all(
        files.map((file) => currentLeftBehindFile(args.home, file.path))
      )
      if (
        !unrecorded.some(Boolean) &&
        files.every(
          (file, index) =>
            sameFacts(file, current[index]?.facts ?? null) &&
            file.mtimeMs <= untouchedSince &&
            // Another name would keep the database alive without the WAL deleted beside it.
            current[index]!.stats.nlink === 1n
        )
      ) {
        eligible.push({ files, stats: current.map((file) => file!.stats) })
      }
    } catch {
      // Left for a later run.
    }
  }
  return eligible
}

/**
 * Deletes (or, in report mode, tallies) the groups still eligible, among only the files the
 * open-file check covered: one a pass recorded since was never asked about.
 */
export async function cleanUpUnusedDatabases(args: {
  home: string
  storeHome: string
  databases: FileFacts[]
  now: number
  minUnchangedDays: number
  open: Set<string>
  checked: Set<string>
  mode: CodexHistoryCleanupMode
  tally: CleanupKindTally
  shouldStop: () => boolean
  /** Asked before each file, sidecars included: false once enforce no longer holds. */
  mayUnlink: () => boolean
  remove: (path: string, stats: BigIntStats) => Promise<void>
}): Promise<void> {
  for (const { files, stats } of await eligibleDatabaseGroups(args)) {
    if (args.shouldStop()) {
      return
    }
    if (files.some((file) => !args.checked.has(file.path))) {
      continue
    }
    if (files.some((file) => args.open.has(fromManifestPath(args.home, file.path)))) {
      args.tally.skipped.open += files.length
      continue
    }
    if (!(await databasesUnused(args.home, args.storeHome))) {
      args.tally.skipped.unshared += files.length
      continue
    }
    args.tally.eligible += files.length
    if (args.mode !== 'enforce') {
      args.tally.deleted += files.length
      args.tally.bytes += stats.reduce((sum, file) => sum + freedBy(file), 0)
      continue
    }
    try {
      // The database first: SQLite discards a WAL left without its database, while a database
      // left without its WAL would lose the commits still in it.
      // Known limit: a ≤1.4.261 macOS downgrade shows a blank /resume preview for a thread whose
      // thread_history database went here, until it is resumed and rebuilt from its rollout.
      for (const index of files
        .map((file, position) => [file.path.length, position])
        .sort((left, right) => left[0] - right[0])
        .map(([, position]) => position)) {
        if (!args.mayUnlink()) {
          return
        }
        await args.remove(files[index].path, stats[index])
      }
    } catch {
      args.tally.skipped.unlink_failed += 1
    }
  }
}
