import type { BigIntStats } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MERGE_PENDING_SUFFIX, lstatIfPresent } from '../../../filesystem/merged-directory-link'
import {
  SET_ASIDE_ROLLOUTS_DIR,
  PRE_SHARE_DATABASES_DIR,
  factsOf,
  fromManifestPath,
  readManifest,
  type FileFacts,
  sameFacts,
  storeFileFacts,
  updateManifest
} from './codex-account-history-cleanup-manifest'
import { checkCodexHistoryLeftBehind, contentSha256 } from './codex-account-history-content-check'
import {
  CLEANUP_MIN_SHARED_DAYS,
  DAY_MS,
  databasesUnused,
  hasProvenShared,
  isTransientDeleteError,
  openFilesOnce
} from './codex-account-history-delete-guards'
import {
  databaseGroup,
  freedBy,
  hasRealFolders,
  isLeftBehindPath,
  removeEmptyFolders
} from './codex-account-left-behind-paths'

// Bounds one run's hashing and open-file check; the rest go on later runs.
const MAX_ROLLOUTS_PER_RUN = 500
const ROLLOUT_BATCH = 100
export type CodexHistoryCleanupResult = { deletedFiles: number; freedBytes: number }

/**
 * Deletes what sharing left behind in an account home, exactly as the cleanup manifest proved it
 * redundant: a set-aside rollout form or merge conflict whose content matched the store copy, while
 * both files keep the size and mtime that check saw and the home file still hashes the same; and
 * the home's own databases, untouched for the grace period, once the home has worked shared that
 * long. Runs under the manifest's lock, so a pass can't change what proved them redundant meanwhile.
 */
export async function cleanUpCodexHistoryLeftBehind(args: {
  accountHome: string
  storeHome: string
  now: number
  shouldStop: () => boolean
}): Promise<CodexHistoryCleanupResult> {
  const result: CodexHistoryCleanupResult = { deletedFiles: 0, freedBytes: 0 }
  const home = args.accountHome
  const manifest = await readManifest(home)
  if (!manifest || manifest === 'newer' || manifest.storeHome !== args.storeHome) {
    return result
  }
  const deleted = new Set<string>()
  // Proven copies that couldn't be deleted, or no longer hash the same: their check stops counting
  // as a match, so they aren't hashed or retried again until they change.
  const voided = new Set<string>()
  const remove = async (path: string, stats: BigIntStats): Promise<void> => {
    await unlink(fromManifestPath(home, path))
    deleted.add(path)
    result.deletedFiles += 1
    result.freedBytes += freedBy(stats)
  }
  const currentFile = async (path: string) => {
    if (!(await hasRealFolders(home, path))) {
      return null
    }
    const stats = await lstatIfPresent(fromManifestPath(home, path))
    return stats?.isFile()
      ? { stats, facts: factsOf(home, fromManifestPath(home, path), stats) }
      : null
  }

  // Each proof is the file itself and its store copy, so no pass can void it meanwhile. Batches
  // keep a stopped run's deletes, and its open-file check small; the check comes before any hash,
  // so one that can't tell costs no hashing.
  const candidates: { path: string; sha256: string; facts: FileFacts }[] = []
  for (const rollout of manifest.rollouts) {
    if (candidates.length >= MAX_ROLLOUTS_PER_RUN) {
      break
    }
    const check = rollout.check
    if (
      check?.sameContent &&
      rollout.storePath === check.store.path &&
      isLeftBehindPath(rollout.path, 'rollout')
    ) {
      candidates.push({ path: rollout.path, sha256: check.sha256, facts: rollout })
    }
  }
  let openCheckFailed = false
  for (let start = 0; start < candidates.length && !openCheckFailed; start += ROLLOUT_BATCH) {
    if (args.shouldStop()) {
      break
    }
    const ready: { path: string; stats: BigIntStats; facts: FileFacts; sha256: string }[] = []
    for (const candidate of candidates.slice(start, start + ROLLOUT_BATCH)) {
      try {
        const file = await currentFile(candidate.path)
        const rollout = manifest.rollouts.find((entry) => entry.path === candidate.path)
        if (
          file &&
          rollout?.check &&
          sameFacts(candidate.facts, file.facts) &&
          sameFacts(
            rollout.check.store,
            await storeFileFacts(args.storeHome, rollout.check.store.path)
          )
        ) {
          ready.push({ ...candidate, stats: file.stats, facts: file.facts })
        }
      } catch {
        // Left for a later run: the manifest still lists it.
      }
    }
    if (ready.length === 0) {
      continue
    }
    const open = await openFilesOnce(
      home,
      ready.map((rollout) => fromManifestPath(home, rollout.path)),
      args.shouldStop
    )
    if (!open) {
      openCheckFailed = true
      break
    }
    for (const rollout of ready) {
      if (args.shouldStop()) {
        break
      }
      if (open.has(fromManifestPath(home, rollout.path))) {
        continue
      }
      try {
        // Size and a millisecond mtime can miss a same-size rewrite of the copy being deleted.
        if ((await contentSha256(fromManifestPath(home, rollout.path))) !== rollout.sha256) {
          voided.add(rollout.path)
          continue
        }
        // Unchanged since the check: a writer that appended and closed meanwhile shows here.
        const now = await currentFile(rollout.path)
        if (now && sameFacts(rollout.facts, now.facts)) {
          await remove(rollout.path, rollout.stats).catch((error: unknown) => {
            if (!isTransientDeleteError(error)) {
              voided.add(rollout.path)
            }
          })
        }
      } catch {
        // Left for a later run.
      }
    }
  }

  // Asked once, only for files otherwise ready to go, and before taking the lock, which a starting
  // pass waits only seconds for. A Codex still holding one open would lose its later writes.
  const readyDatabases =
    hasProvenShared(manifest, args.now) && !openCheckFailed
      ? await databasesReadyToDelete(manifest.databases)
      : []
  const open =
    readyDatabases.length === 0 || args.shouldStop()
      ? null
      : await openFilesOnce(
          home,
          readyDatabases.map((database) => fromManifestPath(home, database.path)),
          args.shouldStop
        )
  // The databases' proof is the sharing streak, so they go under the manifest's lock, which every
  // pass that changes the streak (or unshares and moves the databases aside) takes too.
  await updateManifest(home, async (current) => {
    if (!current || current.storeHome !== args.storeHome) {
      return null
    }
    if (open && readyDatabases.length > 0 && hasProvenShared(current, args.now)) {
      await deleteUnusedDatabases(
        current.databases,
        open,
        new Set(readyDatabases.map((d) => d.path))
      )
    }
    if (deleted.size === 0 && voided.size === 0) {
      return null
    }
    try {
      for (const entry of await readdir(home, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          (entry.name === SET_ASIDE_ROLLOUTS_DIR ||
            entry.name === PRE_SHARE_DATABASES_DIR ||
            entry.name.endsWith(MERGE_PENDING_SUFFIX))
        ) {
          await removeEmptyFolders(join(home, entry.name), args.shouldStop)
        }
      }
    } catch {
      // Empty folders are left for a later run.
    }
    return {
      ...current,
      rollouts: current.rollouts
        .filter((rollout) => !deleted.has(rollout.path))
        .map((rollout) =>
          voided.has(rollout.path) && rollout.check
            ? { ...rollout, check: { ...rollout.check, sameContent: false } }
            : rollout
        ),
      databases: current.databases.filter((database) => !deleted.has(database.path)),
      updatedAt: new Date(args.now).toISOString()
    }
  })
  return result

  // Groups old enough, with no stray WAL or SHM and no second name: only these are worth asking
  // the open-file check about.
  async function databasesReadyToDelete(databases: FileFacts[]): Promise<FileFacts[]> {
    return (await eligibleDatabaseGroups(databases)).flatMap((group) => group.files)
  }

  async function eligibleDatabaseGroups(
    databases: FileFacts[]
  ): Promise<{ files: FileFacts[]; stats: BigIntStats[] }[]> {
    const groups = new Map<string, FileFacts[]>()
    for (const database of databases) {
      if (isLeftBehindPath(database.path, 'database')) {
        const group = databaseGroup(database.path)
        groups.set(group, [...(groups.get(group) ?? []), database])
      }
    }
    // Each pass records the files afresh, so only their age shows nothing has opened them since.
    const untouchedSince = args.now - CLEANUP_MIN_SHARED_DAYS * DAY_MS
    const eligible: { files: FileFacts[]; stats: BigIntStats[] }[] = []
    for (const [group, files] of groups) {
      if (args.shouldStop()) {
        return []
      }
      try {
        const recorded = new Set(files.map((file) => file.path))
        const unrecorded = await Promise.all(
          [group, `${group}-wal`, `${group}-shm`]
            .filter((path) => !recorded.has(path))
            .map((path) => lstatIfPresent(fromManifestPath(home, path)))
        )
        const current = await Promise.all(files.map((file) => currentFile(file.path)))
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

  // Only files the open-file check covered: one a pass recorded since was never asked about.
  async function deleteUnusedDatabases(
    databases: FileFacts[],
    open: Set<string>,
    checked: Set<string>
  ): Promise<void> {
    const eligible = await eligibleDatabaseGroups(databases)
    for (const { files, stats } of eligible) {
      if (
        args.shouldStop() ||
        !(await databasesUnused(home, args.storeHome)) ||
        files.some((file) => !checked.has(file.path) || open.has(fromManifestPath(home, file.path)))
      ) {
        continue
      }
      try {
        // The database first: SQLite discards a WAL left without its database, while a database
        // left without its WAL would lose the commits still in it.
        for (const index of files
          .map((file, position) => [file.path.length, position])
          .sort((left, right) => left[0] - right[0])
          .map(([, position]) => position)) {
          await remove(files[index].path, stats[index])
        }
      } catch {
        // Left for a later run.
      }
    }
  }
}

/** Checks what the home left behind, then deletes what the finished check proved. */
export async function checkThenCleanUpCodexHistory(args: {
  accountHome: string
  storeHome: string
  shouldStop: () => boolean
}): Promise<boolean> {
  if (!(await checkCodexHistoryLeftBehind(args))) {
    return false
  }
  const { deletedFiles, freedBytes } = await cleanUpCodexHistoryLeftBehind({
    ...args,
    now: Date.now()
  })
  if (deletedFiles > 0) {
    console.info(
      `[codex-account-history] Deleted ${deletedFiles} copies left behind in ${args.accountHome}, freeing ${freedBytes} bytes`
    )
  }
  return !args.shouldStop()
}
