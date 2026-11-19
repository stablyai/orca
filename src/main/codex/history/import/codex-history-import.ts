import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import {
  COMPRESSED_ROLLOUT_SUFFIX,
  compressedRolloutsFirst,
  plainWins,
  rolloutTwinPath
} from '../rollouts/codex-rollout-compressed-twin'
import { copyCodexRolloutWithoutOverwrite } from '../rollouts/codex-rollout-copy'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import { isCodexSessionRolloutFileName } from '../rollouts/codex-session-file-listing'
import { readEntries, StoreNames } from './codex-history-store-names'
import {
  hasUnsavedImportLedger,
  readImportLedger,
  writeImportLedger,
  type ImportedFolder,
  type ImportedSource
} from './codex-history-import-ledger'

const ARCHIVED = 'archived_sessions'
const SESSIONS = 'sessions'
const LEDGER_SAVE_EVERY = 50

export type CodexHistoryImportArgs = {
  importHome: string
  storeHome: string
  ledgerPath: string
  indexPendingDir: string
  shouldStop: () => boolean
}

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

function rolloutKey(name: string): string {
  return name.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? name.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length)
    : name
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

// Codex files a rollout under its start date: `rollout-YYYY-MM-DDT...`.
function datedFolderOf(name: string): string | null {
  const stamp = parseCodexRolloutThreadId(name)?.rolloutStamp
  const match = stamp ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(stamp) : null
  return match ? join(SESSIONS, match[1], match[2], match[3]) : null
}

async function childFolders(folder: string): Promise<string[]> {
  return (await readEntries(folder))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
}

/** Day folders under `sessions/`, newest first, relative to the home. */
async function listDayFolders(home: string): Promise<string[]> {
  const days: string[] = []
  for (const year of await childFolders(join(home, SESSIONS))) {
    for (const month of await childFolders(join(home, SESSIONS, year))) {
      for (const day of await childFolders(join(home, SESSIONS, year, month))) {
        days.push(join(SESSIONS, year, month, day))
      }
    }
  }
  return days
}

/** Why an import folder can't feed the store, or null when it can. */
async function unusableReason(importHome: string, storeHome: string): Promise<string | null> {
  if (!isAbsolute(importHome) || parseWslUncPath(importHome)) {
    return 'not an absolute host path'
  }
  const [source, store] = await Promise.all([
    realpathIfPresent(importHome),
    realpathIfPresent(storeHome)
  ])
  if (!source) {
    return 'missing'
  }
  if (store && (isWithin(source, store) || isWithin(store, source))) {
    return 'overlaps the Codex history folder'
  }
  return null
}

type FolderResult = ImportedFolder & { copied: number; stopped: boolean }

// With both forms here, only the one holding every turn is copied: a newer plain form, otherwise
// the non-empty compressed one.
async function losesToFolderTwin(
  folder: string,
  name: string,
  folderNames: Set<string>
): Promise<boolean> {
  const twin = rolloutTwinPath(name)
  if (!folderNames.has(twin)) {
    return false
  }
  const [self, other] = await Promise.all([
    lstatIfPresent(join(folder, name)),
    lstatIfPresent(join(folder, twin))
  ])
  if (!self?.isFile() || !other?.isFile()) {
    return false
  }
  const compressed = name.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
  return compressed === (compressed ? plainWins(other, self) : plainWins(self, other))
}

async function copyIntoStore(from: string, to: string): Promise<'copied' | 'existing' | 'failed'> {
  try {
    // Held from the first byte copied to the link, so a deletion can't race the new name.
    const outcome = await linkCodexRolloutUnlessHeld(from, () =>
      copyCodexRolloutWithoutOverwrite(from, to, { purpose: 'import', requireStableSource: true })
    )
    return outcome === 'copied' || outcome === 'existing' ? outcome : 'failed'
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      console.warn(`[codex-history-import] Could not copy ${from}:`, error)
    }
    return 'failed'
  }
}

async function importFolder(
  args: CodexHistoryImportArgs,
  folder: string,
  source: ImportedSource,
  handled: Set<string>,
  store: StoreNames,
  seedOnly: boolean
): Promise<FolderResult | null> {
  const path = join(args.importHome, folder)
  let before: bigint
  try {
    before = (await stat(path, { bigint: true })).mtimeNs
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  if (source.folders[folder]?.mtimeNs === String(before)) {
    return null
  }
  const archived = folder === ARCHIVED
  const target = archived ? ARCHIVED : folder
  let copied = 0
  let failed = false
  let targetReady = false
  const names = (await readEntries(path))
    .filter((entry) => entry.isFile() && isCodexSessionRolloutFileName(entry.name))
    .map((entry) => entry.name)
    .sort(compressedRolloutsFirst)
  const folderNames = new Set(names)
  for (const name of names) {
    if (args.shouldStop()) {
      return { copied, stopped: true }
    }
    const key = rolloutKey(name)
    if (seedOnly) {
      handled.add(key)
      continue
    }
    // One the user deleted stays deleted whichever form Codex leaves here.
    if (handled.has(key)) {
      continue
    }
    const targetNames = await store.names(target)
    // Any form the store holds wins, here or filed in the other place, whatever its mtime.
    if (
      targetNames.has(name) ||
      targetNames.has(rolloutTwinPath(name)) ||
      (await store.holds(archived ? datedFolderOf(name) : ARCHIVED, name))
    ) {
      handled.add(key)
      continue
    }
    if (await losesToFolderTwin(path, name, folderNames)) {
      continue
    }
    if (!targetReady) {
      await mkdir(join(args.storeHome, target), { recursive: true })
      await mkdir(args.indexPendingDir, { recursive: true })
      targetReady = true
    }
    // Recorded before publishing, so the store's index learns every rollout that joins it.
    await writeFile(join(args.indexPendingDir, name), '')
    const outcome = await copyIntoStore(join(path, name), join(args.storeHome, target, name))
    if (outcome !== 'failed') {
      copied += outcome === 'copied' ? 1 : 0
      handled.add(key)
      targetNames.add(name)
    } else {
      // No heal runs while this pass is active, so the marker can't settle the thread as missing.
      await rm(join(args.indexPendingDir, name), { force: true, maxRetries: 3 })
      failed = true
    }
  }
  const after = (await stat(path, { bigint: true })).mtimeNs
  // A folder that changed while read, or a copy that failed or saw its source change, is read again.
  return {
    copied,
    stopped: false,
    ...(!failed && after === before ? { mtimeNs: String(before) } : {})
  }
}

/**
 * Copies the import folder's rollouts that `~/.codex` lacks into it, never replacing one, so
 * /resume lists them; the ledger keeps each name handled, so one the user deleted stays deleted.
 * Returns how many were copied, or null when it stopped early (progress so far is kept).
 */
export async function importCodexHistory(args: CodexHistoryImportArgs): Promise<number | null> {
  const reason = await unusableReason(args.importHome, args.storeHome)
  if (reason) {
    if (reason !== 'missing') {
      console.warn(`[codex-history-import] Not importing from ${args.importHome}: ${reason}`)
    }
    return 0
  }
  const root = await stat(args.importHome, { bigint: true })
  const identity = `${root.dev}:${root.ino}`
  const sourceKey = normalizeRuntimePathForComparison(await realpath(args.importHome))
  const ledger = await readImportLedger(args.ledgerPath)
  const known = ledger.sources[sourceKey]
  // A replaced folder (restored from a backup, say) is read afresh but keeps what was handled.
  const source: ImportedSource =
    known?.identity === identity
      ? known
      : {
          identity,
          handled: known?.handled ?? [],
          folders: {},
          // After a damaged ledger, passes only record what this folder holds until one finishes.
          ...(known?.seeding || (ledger.recovered && !known) ? { seeding: true } : {})
        }
  ledger.sources[sourceKey] = source
  const seedOnly = source.seeding === true
  let unread = false
  const handled = new Set(source.handled)
  const folders = [ARCHIVED, ...(await listDayFolders(args.importHome))]
  const store = new StoreNames(args.storeHome)
  let copied = 0
  let unsaved = 0
  let stopped = false
  const save = async (): Promise<void> => {
    source.handled = [...handled]
    await writeImportLedger(args.ledgerPath, ledger)
    unsaved = 0
  }
  try {
    for (const folder of folders) {
      if (args.shouldStop()) {
        stopped = true
        break
      }
      let result: FolderResult | null
      const handledBefore = handled.size
      try {
        result = await importFolder(args, folder, source, handled, store, seedOnly)
      } catch (error) {
        unread = true
        // Names this folder copied before failing are kept: they must stay handled.
        unsaved += 1
        // One unreadable folder must not hold back the rest; the next pass reads it again.
        console.warn(
          `[codex-history-import] Could not read ${join(args.importHome, folder)}:`,
          error
        )
        continue
      }
      if (result) {
        const entry: ImportedFolder = result.mtimeNs ? { mtimeNs: result.mtimeNs } : {}
        // A stop that changed nothing writes nothing, so the waiting launch isn't held by a save.
        if (
          result.copied > 0 ||
          handled.size !== handledBefore ||
          JSON.stringify(entry) !== JSON.stringify(source.folders[folder] ?? {})
        ) {
          unsaved += 1
        }
        source.folders[folder] = entry
        copied += result.copied
        if (result.stopped) {
          stopped = true
          break
        }
        if (unsaved >= LEDGER_SAVE_EVERY) {
          await save()
        }
      }
    }
  } finally {
    if (unsaved > 0 || !known || hasUnsavedImportLedger(args.ledgerPath)) {
      await save()
    }
  }
  if (seedOnly && !stopped && !unread) {
    delete source.seeding
    await save()
  }
  if (copied > 0) {
    console.info(`[codex-history-import] Imported ${copied} conversations from ${args.importHome}`)
  }
  return stopped ? null : copied
}
