import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'
import { withFileTransactionLock } from '../../../filesystem/file-transaction-lock'
import { MERGE_PENDING_SUFFIX, lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { listRolloutTwinPairs, rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import { MANIFEST_VERSION, isCurrentManifest } from './codex-account-history-cleanup-manifest-shape'

/**
 * In each account home: the old data sharing left behind, for a later release to delete once the
 * store has proven itself; `cleanUpCodexHistoryLeftBehind` deletes only what it proved redundant.
 */
export const HISTORY_CLEANUP_MANIFEST = '.orca-history-cleanup.json'
/** One form of a rollout whose other form the store holds, kept out so it holds one. */
export const SET_ASIDE_ROLLOUTS_DIR = '.orca-set-aside-rollouts'
/** The account's own databases from before sharing stopped; kept, never read again. */
export const PRE_SHARE_DATABASES_DIR = '.orca-pre-share-db'
export const CODEX_DATABASE_FILE = /\.sqlite(?:-wal|-shm)?$/

const HISTORY_FOLDERS = ['sessions', 'archived_sessions']

/** `path` is relative to its home with `/` separators. */
export type FileFacts = { path: string; bytes: number; mtimeMs: number }

export type ContentCheck = {
  at: string
  /** Byte-equal once either form is decompressed. */
  sameContent: boolean
  sha256: string
  /** The store file as it was checked; a change since voids the check. */
  store: FileFacts
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

export function fromManifestPath(root: string, path: string): string {
  return join(root, ...path.split('/'))
}

export function factsOf(root: string, path: string, stats: BigIntStats): FileFacts {
  return {
    path: toManifestPath(root, path),
    bytes: Number(stats.size),
    mtimeMs: Number(stats.mtimeNs / 1_000_000n)
  }
}

async function readEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

async function* regularFiles(folder: string): AsyncGenerator<{ path: string; stats: BigIntStats }> {
  for (const entry of await readEntries(folder)) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      yield* regularFiles(path)
    } else if (entry.isFile()) {
      const stats = await lstatIfPresent(path)
      if (stats?.isFile()) {
        yield { path, stats }
      }
    }
  }
}

export async function storeFileFacts(storeHome: string, path: string): Promise<FileFacts | null> {
  const stats = await lstatIfPresent(fromManifestPath(storeHome, path))
  return stats?.isFile() ? factsOf(storeHome, fromManifestPath(storeHome, path), stats) : null
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

export function sameFacts(left: FileFacts, right: FileFacts | null): boolean {
  return right !== null && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs
}

async function leftBehindRollouts(
  accountHome: string,
  storeHome: string,
  previous: Map<string, LeftBehindRollout>
): Promise<LeftBehindRollout[]> {
  // A pending folder is `<folder>[.<ms>].orca-profile-merge`; its files conflict by name.
  const sources: { root: string; folder: string; kind: LeftBehindRollout['kind'] }[] = []
  for (const folder of await readEntries(join(accountHome, SET_ASIDE_ROLLOUTS_DIR))) {
    if (folder.isDirectory()) {
      sources.push({
        root: join(accountHome, SET_ASIDE_ROLLOUTS_DIR, folder.name),
        folder: folder.name,
        kind: 'set-aside-twin'
      })
    }
  }
  for (const entry of await readEntries(accountHome)) {
    if (entry.isDirectory() && entry.name.endsWith(MERGE_PENDING_SUFFIX)) {
      const folder = entry.name.slice(0, -MERGE_PENDING_SUFFIX.length).replace(/\.\d+$/, '')
      sources.push({ root: join(accountHome, entry.name), folder, kind: 'merge-conflict' })
    }
  }
  const rollouts: LeftBehindRollout[] = []
  for (const source of sources) {
    for await (const file of regularFiles(source.root)) {
      const inFolder = `${source.folder}/${toManifestPath(source.root, file.path)}`
      // A set-aside form matches the store's other form; a conflict usually its same name.
      const [first, second] =
        source.kind === 'set-aside-twin'
          ? [rolloutTwinPath(inFolder), inFolder]
          : [inFolder, rolloutTwinPath(inFolder)]
      const store =
        (await storeFileFacts(storeHome, first)) ??
        (parseCodexRolloutThreadId(inFolder) ? await storeFileFacts(storeHome, second) : null)
      const facts = factsOf(accountHome, file.path, file.stats)
      const prior = previous.get(facts.path)
      const keepsCheck =
        prior?.check &&
        sameFacts(prior, facts) &&
        prior.storePath === (store?.path ?? null) &&
        sameFacts(prior.check.store, store)
      rollouts.push({
        ...facts,
        kind: source.kind,
        storePath: store?.path ?? null,
        check: keepsCheck ? prior.check : null
      })
    }
  }
  return rollouts
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

/** Plain-form paths of store rollouts present in both forms; names only, no file reads. */
async function storeTwinPairs(storeHome: string): Promise<string[]> {
  const pairs: string[] = []
  for (const folder of HISTORY_FOLDERS) {
    pairs.push(...(await listRolloutTwinPairs(join(storeHome, folder))))
  }
  return pairs.map((path) => toManifestPath(storeHome, path)).sort()
}

/**
 * After a pass: the shared streak (a fully shared pass extends it, turning sharing off resets it)
 * and the databases left behind. Only cheap reads, since a launch awaits the pass; the rollout
 * inventory is rebuilt by `inventoryCodexHistoryLeftBehind` off that path.
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

/** Rebuilds the left-behind rollouts and store twin pairs from disk, keeping still-valid checks. */
export async function inventoryCodexHistoryLeftBehind(args: {
  accountHome: string
  storeHome: string
}): Promise<void> {
  const before = await readManifest(args.accountHome)
  if (!before || before === 'newer') {
    return
  }
  // Walked outside the write, which then touches only these fields: a pass (or, in WSL, another
  // process) may rewrite the streak meanwhile, and a launch never waits behind the walk.
  const previous = new Map(before.rollouts.map((rollout) => [rollout.path, rollout]))
  const rollouts = await leftBehindRollouts(args.accountHome, args.storeHome, previous)
  const pairs = await storeTwinPairs(args.storeHome)
  if (pairs.length > 0) {
    console.warn(
      `[codex-account-history] ${pairs.length} rollouts are in ${args.storeHome} as both .jsonl and .jsonl.zst; both kept`
    )
  }
  await updateManifest(args.accountHome, async (current) => ({
    ...(current ?? before),
    rollouts,
    storeTwinPairs: pairs,
    updatedAt: new Date().toISOString()
  }))
}
