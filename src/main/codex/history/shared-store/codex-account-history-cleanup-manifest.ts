import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'
import { withFileTransactionLock } from '../../../filesystem/file-transaction-lock'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { MANIFEST_VERSION, isCurrentManifest } from './codex-account-history-cleanup-manifest-shape'
import { readEntries, regularFiles } from './codex-account-history-folder-listing'

/** In each account home: the old data sharing left behind, kept until a later release deletes it. */
export const HISTORY_CLEANUP_MANIFEST = '.orca-history-cleanup.json'
/** One form of a rollout whose other form the store holds, kept out so it holds one. */
export const SET_ASIDE_ROLLOUTS_DIR = '.orca-set-aside-rollouts'
/** The account's own databases from before sharing stopped; kept, never read again. */
export const PRE_SHARE_DATABASES_DIR = '.orca-pre-share-db'
export const CODEX_DATABASE_FILE = /\.sqlite(?:-wal|-shm)?$/

/** `path` is relative to its home with `/` separators. */
export type FileFacts = { path: string; bytes: number; mtimeMs: number }

export type ContentCheck = {
  at: string
  /** Byte-equal once either form is decompressed. */
  sameContent: boolean
  sha256: string
  /** The store file as it was checked; a change since voids the check. */
  store: FileFacts
  /** Busy unlinks so far; a changed file gets a fresh check, so this starts over with it. */
  transientFailures?: number
}

export type LeftBehindRollout = FileFacts & {
  kind: 'set-aside-twin' | 'merge-conflict'
  /** The store file holding this content: the other form of a twin, else the same name. */
  storePath: string | null
  check: ContentCheck | null
}

export type CodexHistoryCleanupManifest = {
  version: typeof MANIFEST_VERSION
  storeHome: string
  /** The first and latest fully shared pass (about one per Orca run) since sharing was off. */
  firstSharedAt: string | null
  lastSharedAt: string | null
  sharedPasses: number
  /** Databases Codex no longer opens here: sqlite_home points at the store. */
  databases: FileFacts[]
  rollouts: LeftBehindRollout[]
  /** Store rollouts holding both forms, left there (relative to the store, `.jsonl` form). */
  storeTwinPairs: string[]
  updatedAt: string
}

type CodexHistoryShareOutcome = 'shared' | 'incomplete' | 'unshared'

function toManifestPath(root: string, path: string): string {
  return relative(root, path).split(/[\\/]/).join('/')
}

export function factsOf(root: string, path: string, stats: BigIntStats): FileFacts {
  return {
    path: toManifestPath(root, path),
    bytes: Number(stats.size),
    mtimeMs: Number(stats.mtimeNs / 1_000_000n)
  }
}

/** A newer version's manifest is left alone; anything unreadable or malformed is rebuilt. */
export async function readManifest(
  accountHome: string
): Promise<CodexHistoryCleanupManifest | 'newer' | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(accountHome, HISTORY_CLEANUP_MANIFEST), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
    return null
  }
  if (typeof parsed.version === 'number' && parsed.version > MANIFEST_VERSION) {
    return 'newer'
  }
  return isCurrentManifest(parsed) ? parsed : null
}

async function writeManifest(
  accountHome: string,
  manifest: CodexHistoryCleanupManifest
): Promise<void> {
  const target = join(accountHome, HISTORY_CLEANUP_MANIFEST)
  const staged = `${target}.${randomUUID()}.tmp`
  await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`)
  try {
    await renameFileWithWindowsRetryAsync(staged, target)
  } catch (error) {
    await unlink(staged).catch(() => {})
    throw error
  }
}

// One read-modify-write at a time per home (a pass and its background check).
const manifestUpdates = new Map<string, Promise<void>>()

/** Runs `work` while no pass or check in any process reads or writes this home's manifest. */
export function withManifestLock<T>(accountHome: string, work: () => Promise<T>): Promise<T> {
  // The file lock covers other processes too: each WSL pass and check is its own guest helper.
  const run = (manifestUpdates.get(accountHome) ?? Promise.resolve()).then(() =>
    withFileTransactionLock(join(accountHome, HISTORY_CLEANUP_MANIFEST), work)
  )
  const settled = run.then(
    () => {},
    () => {}
  )
  manifestUpdates.set(accountHome, settled)
  void settled.then(() => {
    if (manifestUpdates.get(accountHome) === settled) {
      manifestUpdates.delete(accountHome)
    }
  })
  return run
}

export function updateManifest(
  accountHome: string,
  /** Null leaves the manifest as it is. */
  update: (
    current: CodexHistoryCleanupManifest | null
  ) => Promise<CodexHistoryCleanupManifest | null>
): Promise<void> {
  return withManifestLock(accountHome, async () => {
    const current = await readManifest(accountHome)
    if (current !== 'newer') {
      const next = await update(current)
      if (next) {
        await writeManifest(accountHome, next)
      }
    }
  })
}

async function databasesLeftBehind(
  accountHome: string,
  includeHomeRoot: boolean
): Promise<FileFacts[]> {
  const databases: FileFacts[] = []
  if (includeHomeRoot) {
    for (const entry of await readEntries(accountHome)) {
      const stats = CODEX_DATABASE_FILE.test(entry.name)
        ? await lstatIfPresent(join(accountHome, entry.name))
        : undefined
      if (stats?.isFile()) {
        databases.push(factsOf(accountHome, join(accountHome, entry.name), stats))
      }
    }
  }
  for await (const file of regularFiles(join(accountHome, PRE_SHARE_DATABASES_DIR))) {
    databases.push(factsOf(accountHome, file.path, file.stats))
  }
  return databases
}

/**
 * After a pass: the shared streak (a fully shared pass extends it, turning sharing off resets it)
 * and the databases left behind. Only cheap reads, since a launch awaits the pass; rollout entries
 * an older build recorded are kept as they are.
 */
export async function recordCodexHistoryLeftBehind(args: {
  accountHome: string
  storeHome: string
  outcome: CodexHistoryShareOutcome
  /** Whether sqlite_home now points the home's Codex at the store's databases. */
  databasesMovedToStore: boolean
}): Promise<void> {
  await updateManifest(args.accountHome, async (current) => {
    const now = new Date().toISOString()
    const sharedNow = args.outcome === 'shared'
    const streak = args.outcome !== 'unshared' && current?.storeHome === args.storeHome
    return {
      version: MANIFEST_VERSION,
      storeHome: args.storeHome,
      firstSharedAt: (streak ? current?.firstSharedAt : null) ?? (sharedNow ? now : null),
      lastSharedAt: sharedNow ? now : streak ? (current?.lastSharedAt ?? null) : null,
      sharedPasses: (streak ? (current?.sharedPasses ?? 0) : 0) + (sharedNow ? 1 : 0),
      databases: await databasesLeftBehind(
        args.accountHome,
        args.outcome !== 'unshared' && args.databasesMovedToStore
      ),
      rollouts: current?.rollouts ?? [],
      storeTwinPairs: current?.storeTwinPairs ?? [],
      updatedAt: now
    }
  })
}
