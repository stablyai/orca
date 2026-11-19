import type { Dirent } from 'node:fs'
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import {
  compressedRolloutsFirst,
  isRolloutTwinKeptFromStore,
  rolloutTwinPath
} from '../rollouts/codex-rollout-compressed-twin'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import { isCodexSessionRolloutFileName } from '../rollouts/codex-session-file-listing'
import { linkCodexSessionFileAsync } from '../rollouts/codex-session-link'
import {
  readImportLedger,
  writeImportLedger,
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

async function readEntries(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
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
  if (store && (await stat(source)).dev !== (await stat(store)).dev) {
    // A hard link can't cross filesystems, and a copy would drift from the conversation.
    return 'on another filesystem'
  }
  return null
}

class StoreNames {
  private readonly folders = new Map<string, Promise<Set<string>>>()

  constructor(private readonly storeHome: string) {}

  names(folder: string): Promise<Set<string>> {
    let names = this.folders.get(folder)
    if (!names) {
      names = readEntries(join(this.storeHome, folder)).then(
        (entries) => new Set(entries.map((entry) => entry.name))
      )
      this.folders.set(folder, names)
    }
    return names
  }

  /** Whether `folder` holds the rollout in either form. */
  async holds(folder: string | null, name: string): Promise<boolean> {
    if (folder === null) {
      return false
    }
    const names = await this.names(folder)
    return names.has(name) || names.has(rolloutTwinPath(name))
  }
}

type FolderResult = { mtimeNs?: string; linked: number; stopped: boolean }

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
  let linked = 0
  let failed = false
  let targetReady = false
  const names = (await readEntries(path))
    .filter((entry) => entry.isFile() && isCodexSessionRolloutFileName(entry.name))
    .map((entry) => entry.name)
    .sort(compressedRolloutsFirst)
  for (const name of names) {
    if (args.shouldStop()) {
      return { linked, stopped: true }
    }
    if (handled.has(name)) {
      continue
    }
    if (seedOnly) {
      handled.add(name)
      continue
    }
    const from = join(path, name)
    const to = join(args.storeHome, target, name)
    const targetNames = await store.names(target)
    // The store's own copy wins: the same name, either form filed in the other place, or a twin
    // holding everything this form has (a newer plain form still joins its compressed one).
    if (
      targetNames.has(name) ||
      (await store.holds(archived ? datedFolderOf(name) : ARCHIVED, name)) ||
      (targetNames.has(rolloutTwinPath(name)) && (await isRolloutTwinKeptFromStore(from, to)))
    ) {
      handled.add(name)
      continue
    }
    if (!targetReady) {
      await mkdir(join(args.storeHome, target), { recursive: true })
      await mkdir(args.indexPendingDir, { recursive: true })
      targetReady = true
    }
    // Recorded before the link, so the store's index learns every rollout that joins it.
    await writeFile(join(args.indexPendingDir, name), '')
    const outcome = await linkCodexSessionFileAsync(from, to, { hardlinkOnly: true })
    if (outcome === 'linked' || outcome === 'existing') {
      linked += outcome === 'linked' ? 1 : 0
      handled.add(name)
      targetNames.add(name)
    } else {
      // No heal runs while this pass is active, so the marker can't settle the thread as missing.
      await rm(join(args.indexPendingDir, name), { force: true })
      failed = true
    }
  }
  const after = (await stat(path, { bigint: true })).mtimeNs
  // A folder that changed while read, or a link that failed, is read again next time.
  return {
    linked,
    stopped: false,
    ...(!failed && after === before ? { mtimeNs: String(before) } : {})
  }
}

/**
 * Hard-links the import folder's rollouts that `~/.codex` lacks into it, never replacing one, so
 * /resume lists them; the ledger keeps each name handled, so one the user deleted stays deleted.
 * Returns how many were linked, or null when it stopped early (progress so far is kept).
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
  // After a damaged ledger, this folder's first pass only records what it holds.
  const seedOnly = ledger.recovered === true && !known
  const source: ImportedSource =
    known?.identity === identity ? known : { identity, handled: [], folders: {} }
  ledger.sources[sourceKey] = source
  const handled = new Set(source.handled)
  const folders = [ARCHIVED, ...(await listDayFolders(args.importHome))]
  const store = new StoreNames(args.storeHome)
  let linked = 0
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
      try {
        result = await importFolder(args, folder, source, handled, store, seedOnly)
      } catch (error) {
        // One unreadable folder must not hold back the rest; the next pass reads it again.
        console.warn(
          `[codex-history-import] Could not read ${join(args.importHome, folder)}:`,
          error
        )
        continue
      }
      if (result) {
        source.folders[folder] = result.mtimeNs ? { mtimeNs: result.mtimeNs } : {}
        linked += result.linked
        unsaved += 1
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
    if (unsaved > 0 || !known) {
      await save()
    }
  }
  if (seedOnly && !stopped) {
    delete ledger.recovered
  }
  if (linked > 0) {
    console.info(`[codex-history-import] Linked ${linked} conversations from ${args.importHome}`)
  }
  return stopped ? null : linked
}
