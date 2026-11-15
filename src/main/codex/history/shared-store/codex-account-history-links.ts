import { mkdir, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import {
  MERGE_PENDING_SUFFIX,
  isLinkedDirectory,
  lstatIfPresent,
  mergeDirectoryIntoLink,
  removeDirectoryLink
} from '../../../filesystem/merged-directory-link'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'

// Created in the store when missing, so a first account still links its history.
const STORE_DIRECTORIES = [
  'sessions',
  'archived_sessions',
  'thread-writer-locks',
  'rollout-migrations'
]

// Local logs and scratch; per-home process endpoints (a linked daemon socket would attach an
// account to the ~/.codex login's daemon); resources Orca links or copies itself, including the
// home's own bundled marketplaces inside `.tmp`.
const PRIVATE_DIRECTORIES = new Set([
  'log',
  'tmp',
  '.tmp',
  'app-server-control',
  'app-server-daemon',
  'ipc',
  'skills',
  'hooks',
  'plugins',
  'plugin-state',
  'profile-v2',
  'themes',
  'prompts',
  'rules'
])

const HISTORY_DIRECTORIES = new Set(['sessions', 'archived_sessions'])

/** Rollouts moved into the store that the store's index still has to learn, one empty file each. */
export const CODEX_INDEX_PENDING_DIR = '.orca-index-pending'
/** The account's own databases from before sharing stopped; kept, never read again. */
const PRE_SHARE_DATABASES_DIR = '.orca-pre-share-db'

/** `shared` once the home's sessions resolve to the store; `private` when a step refused. */
export type CodexAccountHistoryShareResult = 'shared' | 'private' | 'busy'

function isSharedDirectoryName(name: string): boolean {
  return (
    !PRIVATE_DIRECTORIES.has(name) &&
    !name.startsWith('.orca') &&
    !name.endsWith(MERGE_PENDING_SUFFIX)
  )
}

async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

/** Every folder of the store or the home is shared; files (login, config, prompt recall) stay. */
async function sharedDirectoryNames(storeHome: string, accountHome: string): Promise<string[]> {
  const names = new Set(STORE_DIRECTORIES)
  for (const home of [storeHome, accountHome]) {
    for (const entry of await readDirectoryEntries(home)) {
      if (entry.isDirectory()) {
        names.add(entry.name)
      }
    }
  }
  return [...names].filter(isSharedDirectoryName)
}

// Codex deletes a thread lock on release, so one left may guard a live writer; Codex itself
// clears stale ones on its next start, after which a later launch shares the home.
async function hasThreadWriter(accountHome: string): Promise<boolean> {
  const locks = join(accountHome, 'thread-writer-locks')
  if ((await lstatIfPresent(locks))?.isSymbolicLink()) {
    return false
  }
  return (await readDirectoryEntries(locks)).some(
    (entry) => entry.name.endsWith('.lock') && entry.name !== '.coordination.lock'
  )
}

async function isSameDirectory(left: string, right: string): Promise<boolean> {
  const resolve = (path: string): Promise<string | null> =>
    realpath(path).catch((error: unknown) => {
      if (isDefinitiveAbsence(error)) {
        return null
      }
      throw error
    })
  const [a, b] = await Promise.all([resolve(left), resolve(right)])
  return a !== null && a === b
}

// Recorded before the move, so a crash mid-move cannot strand a rollout without its marker.
async function recordIndexPending(accountHome: string, movingPath: string): Promise<void> {
  const pendingDir = join(accountHome, CODEX_INDEX_PENDING_DIR)
  const record = async (path: string): Promise<void> => {
    const entries = await readDirectoryEntries(path)
    if (entries.length === 0 && parseCodexRolloutThreadId(path)) {
      await mkdir(pendingDir, { recursive: true })
      await writeFile(join(pendingDir, basename(path)), '')
      return
    }
    for (const entry of entries) {
      await record(join(path, entry.name))
    }
  }
  await record(movingPath)
}

/**
 * Replaces the account home's history folders with links into the store (the user's ~/.codex),
 * moving the home's own entries there first; the store's copy wins a name conflict and the
 * home's copy stays in `<folder>.orca-profile-merge`. Nothing is deleted.
 */
export async function shareCodexAccountHistory(args: {
  accountHome: string
  storeHome: string
  platform: NodeJS.Platform
  onWarning: (error: unknown) => void
}): Promise<CodexAccountHistoryShareResult> {
  if (await isSameDirectory(args.accountHome, args.storeHome)) {
    // Linking the store into itself would park its history in a pending folder.
    return 'private'
  }
  if (await hasThreadWriter(args.accountHome)) {
    return 'busy'
  }
  await Promise.all(
    STORE_DIRECTORIES.map((name) => mkdir(join(args.storeHome, name), { recursive: true }))
  )
  // Lock files move like any entry: a held lock keeps its inode, now under the shared name.
  for (const name of await sharedDirectoryNames(args.storeHome, args.accountHome)) {
    try {
      await mergeDirectoryIntoLink({
        source: join(args.accountHome, name),
        destination: join(args.storeHome, name),
        platform: args.platform,
        onWarning: args.onWarning,
        beforeMove: HISTORY_DIRECTORIES.has(name)
          ? (path) => recordIndexPending(args.accountHome, path)
          : undefined
      })
    } catch (error) {
      args.onWarning(error)
    }
  }
  return (await isCodexAccountHistoryLinked(args.accountHome, args.storeHome))
    ? 'shared'
    : 'private'
}

/**
 * Sharing turned off: later conversations stay private. Links become fresh empty folders, and the
 * home's pre-share databases (they list files that now live in the store) move aside so Codex
 * starts a private index. History already shared stays in the store.
 */
export async function unshareCodexAccountHistory(args: {
  accountHome: string
  storeHome: string
  onWarning: (error: unknown) => void
}): Promise<void> {
  let unlinked = false
  for (const entry of await readDirectoryEntries(args.accountHome)) {
    const link = join(args.accountHome, entry.name)
    if (
      !isSharedDirectoryName(entry.name) ||
      // Lock folders stay shared: swapping them could split a live writer's namespace.
      entry.name.endsWith('-locks') ||
      !(await isLinkedDirectory(link, join(args.storeHome, entry.name)))
    ) {
      continue
    }
    try {
      await removeDirectoryLink(link)
      await mkdir(link)
      unlinked = true
    } catch (error) {
      args.onWarning(error)
    }
  }
  if (!unlinked) {
    return
  }
  const holding = join(args.accountHome, PRE_SHARE_DATABASES_DIR, String(Date.now()))
  for (const entry of await readDirectoryEntries(args.accountHome)) {
    if (!entry.isFile() || !/\.sqlite(?:-wal|-shm)?$/.test(entry.name)) {
      continue
    }
    try {
      await mkdir(holding, { recursive: true })
      await rename(join(args.accountHome, entry.name), join(holding, entry.name))
    } catch (error) {
      args.onWarning(error)
    }
  }
}

/** The home's databases follow its sessions: shared only once they resolve to the store. */
export function isCodexAccountHistoryLinked(
  accountHome: string,
  storeHome: string
): Promise<boolean> {
  return isLinkedDirectory(join(accountHome, 'sessions'), join(storeHome, 'sessions'))
}

/** Rollout file names this home moved into the store whose index rows are still owed. */
export async function listCodexIndexPendingRollouts(accountHome: string): Promise<string[]> {
  return (await readDirectoryEntries(join(accountHome, CODEX_INDEX_PENDING_DIR)))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}
