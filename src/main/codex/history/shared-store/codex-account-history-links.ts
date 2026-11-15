import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import {
  MERGE_PENDING_SUFFIX,
  isLinkedDirectory,
  lstatIfPresent,
  mergeDirectoryIntoLink,
  removeDirectoryLink
} from '../../../filesystem/merged-directory-link'
import { applyCodexSharedSqliteHome } from '../../configuration/toml/config-toml-shared-sqlite-home'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'

// Created in the store when missing, so a first account still links its history.
const STORE_DIRECTORIES = ['sessions', 'archived_sessions', 'rollout-migrations']

// Local logs and scratch; per-home process endpoints (a linked daemon socket would attach an
// account to the ~/.codex login's daemon); state keyed to the home's own path (encrypted secrets
// whose keyring passphrase is named from CODEX_HOME, the Windows sandbox setup); resources Orca
// links or copies itself, including the home's own bundled marketplaces inside `.tmp`.
const PRIVATE_DIRECTORIES = new Set([
  'log',
  'tmp',
  '.tmp',
  'app-server-control',
  'app-server-daemon',
  'ipc',
  'secrets',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
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
// Linked before any history, so a home never writes shared rollouts under private locks.
const WRITER_LOCKS = 'thread-writer-locks'
/** The account's own databases from before sharing stopped; kept, never read again. */
const PRE_SHARE_DATABASES_DIR = '.orca-pre-share-db'

/** `shared` once the home's history resolves to the store; `private` when a step refused. */
export type CodexAccountHistoryShareResult = 'shared' | 'private' | 'busy'

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
  names.delete(WRITER_LOCKS)
  return [...names].filter(isSharedDirectoryName)
}

// Codex deletes a thread lock on release, so one left may guard a live writer; Codex itself
// clears stale ones on its next start, after which a later launch shares the home.
async function hasThreadWriter(accountHome: string): Promise<boolean> {
  const locks = join(accountHome, WRITER_LOCKS)
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

async function readConfig(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return ''
    }
    throw error
  }
}

/** Orca's sqlite_home line in the home's own config; never the user's ~/.codex config. */
async function writeSharedSqliteHome(
  accountHome: string,
  sqliteHome: string | null
): Promise<void> {
  const configPath = join(accountHome, 'config.toml')
  // A mirror writing meanwhile wins the race; the line is then applied to its content.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readConfig(configPath)
    const next = applyCodexSharedSqliteHome(current, sqliteHome)
    if (next === current) {
      return
    }
    const staged = `${configPath}.${randomUUID()}.tmp`
    // Mirrored MCP environment tokens require owner-only writes.
    await writeFile(staged, next, { mode: 0o600 })
    if ((await readConfig(configPath)) === current) {
      await rename(staged, configPath)
      return
    }
    await unlink(staged)
  }
  throw new Error(`Codex config kept changing; sqlite_home not updated in ${configPath}`)
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
 * Replaces the account home's folders with links into the store (the user's ~/.codex), moving
 * the home's own entries there first; the store's copy wins a name conflict and the home's copy
 * stays in `<folder>.orca-profile-merge`. Nothing is deleted. Codex's databases follow once the
 * history is linked.
 */
export async function shareCodexAccountHistory(
  args: CodexAccountHistoryShareArgs
): Promise<CodexAccountHistoryShareResult> {
  if (await isSameDirectory(args.accountHome, args.storeHome)) {
    // Linking the store into itself would park its history in a pending folder.
    return 'private'
  }
  if (await hasThreadWriter(args.accountHome)) {
    return (await isCodexAccountHistoryLinked(args.accountHome, args.storeHome)) ? 'shared' : 'busy'
  }
  await Promise.all(
    [WRITER_LOCKS, ...STORE_DIRECTORIES].map((name) =>
      mkdir(join(args.storeHome, name), { recursive: true })
    )
  )
  const link = (name: string) =>
    mergeDirectoryIntoLink({
      source: join(args.accountHome, name),
      destination: join(args.storeHome, name),
      platform: args.platform,
      onWarning: args.onWarning,
      beforeShare: HISTORY_DIRECTORIES.has(name)
        ? (path) => recordIndexPending(args.indexPendingDir, path)
        : undefined,
      dropEmptyConflicts: name.endsWith('-locks')
    })
  try {
    // A held lock file moves by hard link, so its inode keeps guarding the thread.
    await link(WRITER_LOCKS)
  } catch (error) {
    args.onWarning(error)
    return 'private'
  }
  for (const name of await sharedDirectoryNames(args.storeHome, args.accountHome)) {
    try {
      await link(name)
    } catch (error) {
      args.onWarning(error)
    }
  }
  if (!(await isCodexAccountHistoryLinked(args.accountHome, args.storeHome))) {
    return 'private'
  }
  await writeSharedSqliteHome(args.accountHome, args.sqliteHome)
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
  await writeSharedSqliteHome(args.accountHome, null)
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

/** Rollout file names whose rows the store's index still owes. */
export async function listCodexIndexPendingRollouts(pendingDir: string): Promise<string[]> {
  return (await readDirectoryEntries(pendingDir))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}
