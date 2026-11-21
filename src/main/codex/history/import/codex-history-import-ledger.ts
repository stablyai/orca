import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'

/** One import folder's day folder (or `archived_sessions`) as last read; older ledgers' `waiting` is ignored. */
export type ImportedFolder = {
  /** Its mtime when read; absent while it still needs another read. */
  mtimeNs?: string
}

export type ImportedSource = {
  /** `dev:ino` of the import folder; a replaced folder starts over. */
  identity: string
  /**
   * Rollout names (without `.zst`) already copied or found in the store, wherever they sit in the import folder
   * now (Codex archives by moving): never copied again, so one the user deleted stays deleted.
   */
  handled: string[]
  folders: Record<string, ImportedFolder>
  /** Set after a damaged ledger: passes only record names until one reads every folder. */
  seeding?: true
}

type ImportLedger = {
  version: 1
  sources: Record<string, ImportedSource>
  /**
   * Once a damaged file lost its record of handled names: every import folder it doesn't know
   * from then on only seeds, since any may have been one whose deletions it held.
   */
  recovered?: true
  /** Generation of the journal that follows this snapshot. */
  journal?: number
}

function emptyLedger(): ImportLedger {
  return { version: 1, sources: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isImportedFolder(value: unknown): value is ImportedFolder {
  return isRecord(value) && (value.mtimeNs === undefined || typeof value.mtimeNs === 'string')
}

function isImportedSource(value: unknown): value is ImportedSource {
  return (
    isRecord(value) &&
    typeof value.identity === 'string' &&
    (value.seeding === undefined || value.seeding === true) &&
    Array.isArray(value.handled) &&
    value.handled.every((name) => typeof name === 'string') &&
    isRecord(value.folders) &&
    Object.values(value.folders).every(isImportedFolder)
  )
}

// Parsed once per run: only this process writes the ledger, and every import keeps it current.
const loaded = new Map<string, Promise<ImportLedger>>()

/**
 * A missing ledger starts empty. A damaged one starts empty and `recovered`: which conversations
 * the user deleted is lost with it, so nothing already in an import folder is copied again.
 */
export function readImportLedger(path: string): Promise<ImportLedger> {
  let ledger = loaded.get(path)
  if (!ledger) {
    ledger = loadImportLedger(path)
    loaded.set(path, ledger)
    ledger.catch(() => loaded.delete(path))
  }
  return ledger
}

async function loadImportLedger(path: string): Promise<ImportLedger> {
  const ledger = await loadImportLedgerFile(path)
  const generation = typeof ledger.journal === 'number' ? ledger.journal : 0
  generations.set(path, generation)
  // A journal whose removal failed after the last snapshot is never replayed; this retries it.
  if (generation > 0) {
    await rm(importJournalPath(path, generation - 1), { force: true }).catch(() => {})
  }
  await replayImportJournal(path, ledger, generation)
  return ledger
}

async function loadImportLedgerFile(path: string): Promise<ImportLedger> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return emptyLedger()
    }
    throw error
  }
  sizesOf(path).ledger = text.length
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sources)) {
      return { ...emptyLedger(), recovered: true }
    }
    const sources: Record<string, ImportedSource> = {}
    let damaged = false
    for (const [key, source] of Object.entries(parsed.sources)) {
      if (isImportedSource(source)) {
        sources[key] = source
      } else {
        damaged = true
      }
    }
    const journal = typeof parsed.journal === 'number' ? { journal: parsed.journal } : {}
    // A dropped entry lost its record of handled names like a damaged file does.
    return damaged || parsed.recovered === true
      ? { version: 1, sources, recovered: true, ...journal }
      : { version: 1, sources, ...journal }
  } catch {
    console.warn(`[codex-history-import] Damaged ledger ${path}; importing only new conversations`)
    return { ...emptyLedger(), recovered: true }
  }
}

// Ledgers whose last write failed: the cached copy is ahead of the file until a write succeeds.
const unsaved = new Set<string>()

export function hasUnsavedImportLedger(path: string): boolean {
  return unsaved.has(path)
}

/** Replaces `path` whole, so a crash mid-write leaves the previous contents. */
export async function replaceImportFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, contents)
    await renameFileWithWindowsRetryAsync(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

// Bytes in each ledger's snapshot and in its journal since that snapshot was written.
const sizes = new Map<string, { ledger: number; journal: number }>()
// Each loaded ledger's journal generation.
const generations = new Map<string, number>()
// Ledgers whose folder this run already created, so an append doesn't ask again.
const folderReady = new Set<string>()
// A journal this big is folded into the snapshot: a rewrite per half a snapshot of appends.
const MIN_COMPACT_JOURNAL_BYTES = 64 * 1024

function sizesOf(path: string): { ledger: number; journal: number } {
  let entry = sizes.get(path)
  if (!entry) {
    entry = { ledger: 0, journal: 0 }
    sizes.set(path, entry)
  }
  return entry
}

/** Whether the pass's end should write the whole ledger: a write failed, or the journal has grown. */
export function importLedgerNeedsWrite(path: string): boolean {
  const size = sizesOf(path)
  return unsaved.has(path) || size.journal >= Math.max(MIN_COMPACT_JOURNAL_BYTES, size.ledger / 2)
}

/**
 * Writes the whole ledger, which names a fresh journal: the old one is never replayed again, so a
 * failure removing it costs only the file.
 */
export async function writeImportLedger(path: string, ledger: ImportLedger): Promise<void> {
  unsaved.add(path)
  const previous = generations.get(path) ?? 0
  ledger.journal = previous + 1
  const text = JSON.stringify(ledger)
  try {
    await replaceImportFile(path, text)
  } catch (error) {
    ledger.journal = previous
    throw error
  }
  generations.set(path, previous + 1)
  unsaved.delete(path)
  sizes.set(path, { ledger: text.length, journal: 0 })
  await rm(importJournalPath(path, previous), { force: true }).catch((error: unknown) =>
    console.warn('[codex-history-import] Could not remove an old import journal:', error)
  )
}

// Progress since the snapshot was written, one line per append, so progress costs only what changed.
function importJournalPath(ledgerPath: string, generation: number): string {
  return `${ledgerPath}.journal-${generation}.jsonl`
}

export type ImportJournalLine = {
  source: string
  identity: string
  handled?: string[]
  /** Names an earlier line recorded before a copy that then didn't join the store. */
  released?: string[]
  folders?: Record<string, ImportedFolder>
}

function isNameList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((n) => typeof n === 'string'))
}

function isImportJournalLine(value: unknown): value is ImportJournalLine {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.identity === 'string' &&
    isNameList(value.handled) &&
    isNameList(value.released) &&
    (value.folders === undefined ||
      (isRecord(value.folders) && Object.values(value.folders).every(isImportedFolder)))
  )
}

/** Records progress since the last ledger write; a failed append leaves the whole ledger to be written. */
export async function appendImportProgress(path: string, line: ImportJournalLine): Promise<void> {
  const text = `\n${JSON.stringify(line)}\n`
  try {
    if (!folderReady.has(path)) {
      await mkdir(dirname(path), { recursive: true })
      folderReady.add(path)
    }
    // Leading newline: a line a crash cut short never swallows the next one.
    await appendFile(importJournalPath(path, generations.get(path) ?? 0), text)
    sizesOf(path).journal += text.length
  } catch (error) {
    unsaved.add(path)
    console.warn('[codex-history-import] Could not record import progress:', error)
  }
}

/** Applies a line the way an import pass applies the same progress to its source. */
function applyJournalLine(
  ledger: ImportLedger,
  line: ImportJournalLine,
  handledBySource: Map<ImportedSource, Set<string>>
): void {
  let source = ledger.sources[line.source]
  if (!source) {
    source = {
      identity: line.identity,
      handled: [],
      folders: {},
      ...(ledger.recovered ? { seeding: true as const } : {})
    }
    ledger.sources[line.source] = source
  } else if (source.identity !== line.identity) {
    // A replaced folder is read afresh but keeps what was handled.
    source.identity = line.identity
    source.folders = {}
  }
  let names = handledBySource.get(source)
  if (!names) {
    names = new Set(source.handled)
    handledBySource.set(source, names)
  }
  for (const name of line.handled ?? []) {
    names.add(name)
  }
  for (const name of line.released ?? []) {
    names.delete(name)
  }
  // A seeding source reads every folder again, whatever an earlier pass settled.
  if (!source.seeding) {
    Object.assign(source.folders, line.folders)
  }
}

/** After a lost journal line, which may have held any source's names: every source seeds again. */
function seedEverySource(ledger: ImportLedger): void {
  ledger.recovered = true
  for (const source of Object.values(ledger.sources)) {
    source.seeding = true
    source.folders = {}
  }
}

async function replayImportJournal(
  path: string,
  ledger: ImportLedger,
  generation: number
): Promise<void> {
  let text: string
  try {
    text = await readFile(importJournalPath(path, generation), 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    console.warn('[codex-history-import] Unreadable import journal; recording names again:', error)
    seedEverySource(ledger)
    unsaved.add(path)
    return
  }
  sizesOf(path).journal = text.length
  const lines = text.split('\n').filter((raw) => raw.trim())
  const handledBySource = new Map<ImportedSource, Set<string>>()
  let damaged = false
  lines.forEach((raw, index) => {
    let line: unknown = null
    try {
      line = JSON.parse(raw)
    } catch {
      // Only the last line can be cut short by a crash; any other is damage.
    }
    if (isImportJournalLine(line)) {
      applyJournalLine(ledger, line, handledBySource)
    } else if (index < lines.length - 1) {
      damaged = true
    }
  })
  for (const [source, names] of handledBySource) {
    source.handled = [...names]
  }
  if (damaged) {
    console.warn(`[codex-history-import] Damaged import journal for ${path}; recording names again`)
    seedEverySource(ledger)
    unsaved.add(path)
  }
}
