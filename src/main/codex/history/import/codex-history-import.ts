import { mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  COMPRESSED_ROLLOUT_SUFFIX,
  rolloutTwinPath
} from '../rollouts/codex-rollout-compressed-twin'
import { isCodexSessionRolloutFileName } from '../rollouts/codex-session-file-listing'
import { StoreNames, readEntries } from './codex-history-store-names'
import { datedFolderOf, listDayFolders } from './codex-history-import-folders'
import { importHomeUnusableReason } from './codex-history-import-home-check'
import { copyConversationIntoStore } from './codex-history-import-conversation'
import { canHardLinkIn, pickImportForm } from './codex-history-import-staging'
import {
  removeAbandonedStagedImports,
  stagingRecordPath
} from './codex-history-import-staging-record'
import {
  appendImportProgress,
  importLedgerNeedsWrite,
  readImportLedger,
  writeImportLedger,
  type ImportedFolder,
  type ImportedSource
} from './codex-history-import-ledger'

const ARCHIVED = 'archived_sessions'

export type CodexHistoryImportArgs = {
  importHome: string
  storeHome: string
  ledgerPath: string
  indexPendingDir: string
  /** Names this run's staged copies, so a sweep leaves them alone. */
  runId: string
  /** The import setting is unchanged and Orca isn't quitting. */
  isCurrent: () => boolean
  /** Resolves once no launch waits for the history queue. */
  waitForLaunches: () => Promise<void>
  /** Runs a short publish job inside the history queue. */
  publish: <T>(job: () => Promise<T>) => Promise<T>
}

function rolloutKey(name: string): string {
  return name.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? name.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length)
    : name
}

type HandledRecord = { handled?: string[]; released?: string[] }

/** A source's names never copied again; each one added is journaled by the next `flush`. */
class HandledNames {
  private readonly names: Set<string>
  private pending: string[] = []
  // Journaled before their copy was published: no need to journal them again.
  private readonly recorded = new Set<string>()

  constructor(
    private readonly source: ImportedSource,
    private readonly record: (change: HandledRecord) => Promise<void>
  ) {
    this.names = new Set(source.handled)
  }

  recordIntent(name: string): Promise<void> {
    this.recorded.add(name)
    return this.record({ handled: [name] })
  }

  releaseIntent(name: string): Promise<void> {
    this.recorded.delete(name)
    return this.record({ released: [name] })
  }

  has(name: string): boolean {
    return this.names.has(name)
  }

  add(name: string): void {
    if (!this.names.has(name)) {
      this.names.add(name)
      this.source.handled.push(name)
      if (!this.recorded.delete(name)) {
        this.pending.push(name)
      }
    }
  }

  async flush(): Promise<void> {
    if (this.pending.length > 0) {
      const names = this.pending
      this.pending = []
      await this.record({ handled: names })
    }
  }
}

type FolderResult = ImportedFolder & {
  copied: number
  stopped: boolean
  /** Ends the pass: the store can't take a copy. */
  halt?: 'no-hard-links' | 'failed'
}

async function importFolder(
  args: CodexHistoryImportArgs,
  folder: string,
  source: ImportedSource,
  handled: HandledNames,
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
  // Each conversation is decided once, whichever forms it has here, so a stop keeps the progress.
  const forms = new Map<string, string[]>()
  for (const entry of await readEntries(path)) {
    if (entry.isFile() && isCodexSessionRolloutFileName(entry.name)) {
      const key = rolloutKey(entry.name)
      forms.set(key, [...(forms.get(key) ?? []), entry.name])
    }
  }
  for (const [key, keyForms] of forms) {
    if (seedOnly) {
      handled.add(key)
      continue
    }
    // One the user deleted stays deleted whichever form Codex leaves here.
    if (handled.has(key)) {
      continue
    }
    if (!args.isCurrent()) {
      return { copied, stopped: true }
    }
    // Copies yield to launches between conversations; a launch never waits behind one.
    await args.waitForLaunches()
    const otherFolder = archived ? datedFolderOf(key) : ARCHIVED
    const targetNames = await store.names(target)
    // Any form the store holds wins, here or filed in the other place, whatever its mtime.
    if (
      targetNames.has(key) ||
      targetNames.has(rolloutTwinPath(key)) ||
      (await store.holds(otherFolder, key))
    ) {
      handled.add(key)
      continue
    }
    const name = await pickImportForm(path, key, keyForms)
    if (!name) {
      failed = true
      continue
    }
    const targetDir = join(args.storeHome, target)
    if (!targetReady) {
      await mkdir(targetDir, { recursive: true })
      if (!(await canHardLinkIn(targetDir, args.runId))) {
        return { copied, stopped: false, halt: 'no-hard-links' }
      }
      await mkdir(args.indexPendingDir, { recursive: true })
      targetReady = true
    }
    const published = await copyConversationIntoStore(args, {
      from: join(path, name),
      targetDir,
      name,
      otherFolder: otherFolder ? join(args.storeHome, otherFolder) : null,
      isHandled: () => handled.has(key),
      recordIntent: () => handled.recordIntent(key),
      releaseIntent: () => handled.releaseIntent(key)
    })
    if (published === 'failed') {
      return { copied, stopped: false, halt: 'failed' }
    }
    if (published === 'refused') {
      failed = true
      continue
    }
    copied += published === 'copied' ? 1 : 0
    handled.add(key)
    targetNames.add(name)
  }
  const after = (await stat(path, { bigint: true })).mtimeNs
  // Settled only once every conversation in it was published or found in the store.
  return {
    copied,
    stopped: false,
    ...(!failed && after === before ? { mtimeNs: String(before) } : {})
  }
}

/**
 * Copies the import folder's rollouts that `~/.codex` lacks into it, never replacing one, so
 * /resume lists them; the ledger keeps each name handled, so one the user deleted stays deleted.
 * Runs outside the history queue and publishes each copy through `args.publish`.
 * Returns how many were copied, or null when it stopped early (progress so far is kept).
 */
export async function importCodexHistory(args: CodexHistoryImportArgs): Promise<number | null> {
  await removeAbandonedStagedImports(stagingRecordPath(args.ledgerPath)).catch((error: unknown) =>
    console.warn('[codex-history-import] Could not remove an abandoned staged copy:', error)
  )
  const reason = await importHomeUnusableReason(args.importHome, args.storeHome)
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
          // After a damaged ledger, passes only record what a folder it lost holds until one finishes.
          ...(known?.seeding || (ledger.recovered && !known) ? { seeding: true } : {})
        }
  ledger.sources[sourceKey] = source
  const seedOnly = source.seeding === true
  const handled = new HandledNames(source, (change) =>
    appendImportProgress(args.ledgerPath, { source: sourceKey, identity, ...change })
  )
  const listing = await listDayFolders(args.importHome)
  // A pass that skipped an unreadable folder hasn't read everything yet.
  let unread = !listing.complete
  const folders = [ARCHIVED, ...listing.days]
  const store = new StoreNames(args.storeHome, args.runId)
  let copied = 0
  let stopped = false
  let finished = false
  // Folders whose entry this pass changed, journaled once at its end.
  const changedFolders: Record<string, ImportedFolder> = {}
  try {
    for (const folder of folders) {
      if (!args.isCurrent()) {
        stopped = true
        break
      }
      let result: FolderResult | null
      try {
        result = await importFolder(args, folder, source, handled, store, seedOnly)
      } catch (error) {
        unread = true
        // One unreadable folder must not hold back the rest; the next pass reads it again.
        console.warn(
          `[codex-history-import] Could not read ${join(args.importHome, folder)}:`,
          error
        )
        continue
      } finally {
        await handled.flush()
      }
      if (result) {
        const entry: ImportedFolder = result.mtimeNs ? { mtimeNs: result.mtimeNs } : {}
        if (entry.mtimeNs !== source.folders[folder]?.mtimeNs) {
          changedFolders[folder] = entry
        }
        source.folders[folder] = entry
        copied += result.copied
        if (result.stopped) {
          stopped = true
          break
        }
        if (result.halt) {
          break
        }
      }
    }
    finished = true
  } finally {
    // A stop that changed nothing writes nothing, so the waiting launch isn't held by a write.
    if (Object.keys(changedFolders).length > 0) {
      await appendImportProgress(args.ledgerPath, {
        source: sourceKey,
        identity,
        folders: changedFolders
      })
    }
    if (seedOnly && finished && !stopped && !unread) {
      delete source.seeding
    }
    // Seeding ends only in the ledger itself, which the journal can't change.
    if ((seedOnly && !source.seeding) || importLedgerNeedsWrite(args.ledgerPath)) {
      await writeImportLedger(args.ledgerPath, ledger)
    }
  }
  if (copied > 0) {
    console.info(`[codex-history-import] Imported ${copied} conversations from ${args.importHome}`)
  }
  return stopped ? null : copied
}
