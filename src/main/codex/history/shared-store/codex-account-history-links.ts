import { mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
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
// Hold only lock files guarding shared state; the home's own copy is replaced, not merged.
const LOCK_DIRECTORIES = new Set([
  'thread-writer-locks',
  'mcp-oauth-locks',
  'project-metadata-locks'
])

/** Rollouts moved into the store that the store's index still has to learn, one empty file each. */
export const CODEX_INDEX_PENDING_DIR = '.orca-index-pending'
/** The account's own databases from before sharing stopped; kept, never read again. */
const PRE_SHARE_DATABASES_DIR = '.orca-pre-share-db'

export type CodexAccountHistoryShareResult = 'shared' | 'busy'

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

/** Every store folder an account shares; files (login, config, prompt recall) stay with the home. */
async function sharedDirectoryNames(storeHome: string): Promise<string[]> {
  const names = new Set(STORE_DIRECTORIES)
  for (const entry of await readDirectoryEntries(storeHome)) {
    if (entry.isDirectory()) {
      names.add(entry.name)
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

async function recordIndexPending(accountHome: string, movedPath: string): Promise<void> {
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
  await record(movedPath)
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
    return 'shared'
  }
  if (await hasThreadWriter(args.accountHome)) {
    return 'busy'
  }
  await Promise.all(
    STORE_DIRECTORIES.map((name) => mkdir(join(args.storeHome, name), { recursive: true }))
  )
  for (const name of await sharedDirectoryNames(args.storeHome)) {
    try {
      const source = join(args.accountHome, name)
      if (LOCK_DIRECTORIES.has(name) && (await lstatIfPresent(source))?.isDirectory()) {
        await rm(source, { recursive: true })
      }
      await mergeDirectoryIntoLink({
        source,
        destination: join(args.storeHome, name),
        platform: args.platform,
        onWarning: args.onWarning,
        onMoved: HISTORY_DIRECTORIES.has(name)
          ? (movedPath) => recordIndexPending(args.accountHome, movedPath)
          : undefined
      })
    } catch (error) {
      args.onWarning(error)
    }
  }
  return 'shared'
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

/** Rollout file names this home moved into the store whose index rows are still owed. */
export async function listCodexIndexPendingRollouts(accountHome: string): Promise<string[]> {
  return (await readDirectoryEntries(join(accountHome, CODEX_INDEX_PENDING_DIR)))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}
