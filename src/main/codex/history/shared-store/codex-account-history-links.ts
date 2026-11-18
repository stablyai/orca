import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'
import {
  DirectoryLinkError,
  isLinkedDirectory,
  lstatIfPresent,
  mergeDirectoryIntoLink,
  removeDirectoryLink
} from '../../../filesystem/merged-directory-link'
import {
  LINKED_MANAGED_HOME_MARKER,
  MANAGED_HOME_MARKER
} from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import {
  COORDINATION_LOCK,
  hasThreadLockConflict,
  hasThreadWriter,
  hasThreadWriterInStore,
  WRITER_LOCKS
} from './codex-thread-writer-locks'
import { writeSharedSqliteHome } from './codex-account-sqlite-home-config'
import {
  CODEX_DATABASE_FILE,
  PRE_SHARE_DATABASES_DIR,
  SET_ASIDE_ROLLOUTS_DIR,
  recordCodexHistoryLeftBehind
} from './codex-account-history-cleanup-manifest'
import {
  compressedRolloutsFirst,
  holdsRolloutTwins,
  isRolloutTwinKeptFromStore
} from '../rollouts/codex-rollout-compressed-twin'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import {
  earlierStoreOf,
  isLinkInto,
  isSameDirectory,
  isSharedDirectoryName,
  linksIntoStore,
  readDirectoryEntries,
  sharedDirectoryNames,
  STORE_DIRECTORIES
} from './codex-shared-history-folders'

const HISTORY_DIRECTORIES = new Set(['sessions', 'archived_sessions'])
// Linked before any history, so a home never writes shared rollouts under private locks.
// Present from the first unlinked folder until the databases moved aside, so a retry finishes.
const UNSHARE_PENDING = '.orca-unshare-pending'

/**
 * `shared` once the home's history resolves to the store; `incomplete` when it does but some entry
 * failed to move (a later pass retries it); `private` when a step refused.
 */
export type CodexAccountHistoryShareResult = 'shared' | 'incomplete' | 'private' | 'busy'

export type CodexAccountHistoryShareArgs = {
  accountHome: string
  storeHome: string
  /** Where Codex keeps the store's databases, written into the home's config; null writes none. */
  sqliteHome: string | null
  /** Rollouts the store's index still has to learn, one empty file each, shared by every account. */
  indexPendingDir: string
  platform: NodeJS.Platform
  onWarning: (error: unknown) => void
}

// Recorded before the move, so a crash mid-move cannot strand a rollout without its marker.
async function recordIndexPending(pendingDir: string, path: string): Promise<void> {
  const entries = await readDirectoryEntries(path)
  if (entries.length === 0 && parseCodexRolloutThreadId(path)) {
    await mkdir(pendingDir, { recursive: true })
    await writeFile(join(pendingDir, basename(path)), '')
    return
  }
  for (const entry of entries) {
    await recordIndexPending(pendingDir, join(path, entry.name))
  }
}

/** False when the home has no ownership marker; a link must never land in an unowned home. */
async function markHomeLinked(accountHome: string): Promise<boolean> {
  try {
    await renameFileWithWindowsRetryAsync(
      join(accountHome, MANAGED_HOME_MARKER),
      join(accountHome, LINKED_MANAGED_HOME_MARKER)
    )
    return true
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  return (await lstatIfPresent(join(accountHome, LINKED_MANAGED_HOME_MARKER)))?.isFile() ?? false
}

/** Both history folders: Codex archives by moving a rollout between them. */
export async function isCodexAccountHistoryLinked(
  accountHome: string,
  storeHome: string
): Promise<boolean> {
  const linked = await Promise.all(
    [...HISTORY_DIRECTORIES].map((name) =>
      isLinkedDirectory(join(accountHome, name), join(storeHome, name))
    )
  )
  return linked.every(Boolean)
}

/**
 * Replaces the account home's folders with links into the store (the Codex history folder, ~/.codex
 * by default), moving
 * the home's own entries there first; the store's copy wins a name conflict and the home's copy
 * stays in `<folder>.orca-profile-merge`, and a rollout form the store must not hold beside its
 * twin waits in `.orca-set-aside-rollouts`. Nothing is deleted. Codex's databases follow once the
 * history is linked.
 */
export async function shareCodexAccountHistory(
  args: CodexAccountHistoryShareArgs
): Promise<CodexAccountHistoryShareResult> {
  if (await isSameDirectory(args.accountHome, args.storeHome)) {
    // Linking the store into itself would park its history in a pending folder.
    return 'private'
  }
  // An older build's recursive removal would follow a junction and delete the store's history.
  if (args.platform === 'win32' && !(await markHomeLinked(args.accountHome))) {
    return 'private'
  }
  if (await hasThreadWriter(args.accountHome)) {
    return (await isCodexAccountHistoryLinked(args.accountHome, args.storeHome)) ? 'shared' : 'busy'
  }
  // The Codex history folder changed: an idle home's links follow it, and what the earlier folder
  // holds stays there.
  const earlierStore = await earlierStoreOf(args.accountHome, args.storeHome)
  if (earlierStore) {
    // The home's lock folder is that folder's: a writer anywhere in it may be this home's Codex.
    if (await hasThreadWriterInStore(earlierStore)) {
      console.info(
        '[codex-account-history] Waiting for Codex to stop in the earlier history folder:',
        earlierStore
      )
      return 'busy'
    }
    for (const link of await linksIntoStore(args.accountHome, earlierStore)) {
      await removeDirectoryLink(link)
    }
  }
  // Also clears the store's free locks, so a lock taken in the account from now on has no twin.
  await hasThreadWriter(args.storeHome)
  if (await hasThreadLockConflict(args.accountHome, args.storeHome)) {
    return 'busy'
  }
  await Promise.all(
    [WRITER_LOCKS, ...STORE_DIRECTORIES].map((name) =>
      mkdir(join(args.storeHome, name), { recursive: true })
    )
  )
  let failed = false
  const onWarning = (error: unknown): void => {
    // A kept conflict is final; anything else left an entry behind for a later pass.
    failed ||= !(error instanceof DirectoryLinkError && error.code === 'retained-conflict')
    args.onWarning(error)
  }
  const link = (name: string) =>
    mergeDirectoryIntoLink({
      source: join(args.accountHome, name),
      destination: join(args.storeHome, name),
      platform: args.platform,
      onWarning,
      beforeShare: HISTORY_DIRECTORIES.has(name)
        ? (path) => recordIndexPending(args.indexPendingDir, path)
        : undefined,
      ...(HISTORY_DIRECTORIES.has(name) && {
        setAsidePath: async (from: string, to: string) =>
          (await isRolloutTwinKeptFromStore(from, to))
            ? join(
                args.accountHome,
                SET_ASIDE_ROLLOUTS_DIR,
                name,
                relative(join(args.storeHome, name), to)
              )
            : null,
        movesWhole: async (folder: string) => !(await holdsRolloutTwins(folder)),
        // The `.zst` reaches the store first, so its `.jsonl` is set aside only beside it.
        entryOrder: compressedRolloutsFirst
      }),
      // A thread lock is never dropped unproven; only an empty coordination file is.
      dropEmptyConflicts: name.endsWith('-locks')
        ? (path) => name !== WRITER_LOCKS || basename(path) === COORDINATION_LOCK
        : undefined
    })
  try {
    // A held lock file moves by hard link, so its inode keeps guarding the thread.
    await link(WRITER_LOCKS)
  } catch (error) {
    onWarning(error)
    return 'private'
  }
  // A user's own link elsewhere would split the lock namespace from the history's.
  if (
    !(await isLinkedDirectory(
      join(args.accountHome, WRITER_LOCKS),
      join(args.storeHome, WRITER_LOCKS)
    ))
  ) {
    return 'private'
  }
  for (const name of await sharedDirectoryNames(args.storeHome, args.accountHome)) {
    try {
      await link(name)
    } catch (error) {
      onWarning(error)
    }
  }
  if (!(await isCodexAccountHistoryLinked(args.accountHome, args.storeHome))) {
    return 'private'
  }
  await writeSharedSqliteHome(args.accountHome, args.sqliteHome)
  const result = failed ? 'incomplete' : 'shared'
  await recordCodexHistoryLeftBehind({
    accountHome: args.accountHome,
    storeHome: args.storeHome,
    outcome: result,
    databasesMovedToStore: args.sqliteHome !== null
  }).catch(args.onWarning)
  return result
}

/**
 * Sharing turned off: later conversations stay private. Links become fresh empty folders, and the
 * home's pre-share databases (they list files that now live in the store) move aside so Codex
 * starts a private index. History already shared stays in the store. False when a link stayed.
 */
export async function unshareCodexAccountHistory(args: {
  accountHome: string
  storeHome: string
  onWarning: (error: unknown) => void
}): Promise<boolean> {
  let unlinked = false
  let complete = true
  // Links into an earlier Codex history folder are the home's too.
  const earlierStore = await earlierStoreOf(args.accountHome, args.storeHome)
  // By resolved folder too: the configured folder may be another path to the same one.
  const isLinkedToStore = async (link: string): Promise<boolean> =>
    (await isLinkInto(link, args.storeHome)) ||
    (await isLinkedDirectory(link, join(args.storeHome, basename(link)))) ||
    (earlierStore !== null && (await isLinkInto(link, earlierStore)))
  for (const entry of await readDirectoryEntries(args.accountHome)) {
    const link = join(args.accountHome, entry.name)
    if (
      !isSharedDirectoryName(entry.name) ||
      // Lock folders stay shared: swapping them could split a live writer's namespace.
      entry.name.endsWith('-locks') ||
      !(await isLinkedToStore(link))
    ) {
      continue
    }
    try {
      if (!unlinked) {
        await writeFile(join(args.accountHome, UNSHARE_PENDING), '')
      }
      await removeDirectoryLink(link)
      await mkdir(link)
      unlinked = true
    } catch (error) {
      complete = false
      args.onWarning(error)
    }
  }
  await writeSharedSqliteHome(args.accountHome, null)
  const pending = join(args.accountHome, UNSHARE_PENDING)
  if (!unlinked && !(await lstatIfPresent(pending))) {
    return complete
  }
  const holding = join(args.accountHome, PRE_SHARE_DATABASES_DIR, String(Date.now()))
  for (const entry of await readDirectoryEntries(args.accountHome)) {
    if (!entry.isFile() || !CODEX_DATABASE_FILE.test(entry.name)) {
      continue
    }
    try {
      await mkdir(holding, { recursive: true })
      await rename(join(args.accountHome, entry.name), join(holding, entry.name))
    } catch (error) {
      complete = false
      args.onWarning(error)
    }
  }
  if (complete) {
    await unlink(pending)
  }
  await recordCodexHistoryLeftBehind({
    accountHome: args.accountHome,
    // The kept lock link still points into the earlier folder; a later share moves it from there.
    storeHome:
      earlierStore !== null &&
      (await isLinkInto(join(args.accountHome, WRITER_LOCKS), earlierStore))
        ? earlierStore
        : args.storeHome,
    outcome: 'unshared',
    databasesMovedToStore: false
  }).catch(args.onWarning)
  return complete
}

/** Rollout file names whose rows the store's index still owes. */
export async function listCodexIndexPendingRollouts(pendingDir: string): Promise<string[]> {
  return (await readDirectoryEntries(pendingDir))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}
