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
  await replayHandledJournal(path, ledger)
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
    // A dropped entry lost its record of handled names like a damaged file does.
    return damaged || parsed.recovered === true
      ? { version: 1, sources, recovered: true }
      : { version: 1, sources }
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

export async function writeImportLedger(path: string, ledger: ImportLedger): Promise<void> {
  unsaved.add(path)
  await replaceImportFile(path, JSON.stringify(ledger))
  // The ledger now holds every name the journal did; a crash before this only replays them again.
  await rm(handledJournalPath(path), { force: true })
  unsaved.delete(path)
}

// Names handled since the ledger was last written, one line per append, so progress costs only what changed.
function handledJournalPath(ledgerPath: string): string {
  return `${ledgerPath}.handled.jsonl`
}

type HandledJournalLine = { source: string; identity: string; handled: string[] }

function isHandledJournalLine(value: unknown): value is HandledJournalLine {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.identity === 'string' &&
    Array.isArray(value.handled) &&
    value.handled.every((name) => typeof name === 'string')
  )
}

/**
 * Records names handled since the last ledger write. A failed append leaves the ledger unsaved,
 * so the pass's closing write keeps them instead.
 */
export async function appendHandledNames(
  path: string,
  source: { key: string; identity: string },
  names: string[]
): Promise<void> {
  if (names.length === 0) {
    return
  }
  const line: HandledJournalLine = { source: source.key, identity: source.identity, handled: names }
  try {
    await mkdir(dirname(path), { recursive: true })
    // Leading newline: a line a crash cut short never swallows the next one.
    await appendFile(handledJournalPath(path), `\n${JSON.stringify(line)}\n`)
  } catch (error) {
    unsaved.add(path)
    console.warn('[codex-history-import] Could not record imported conversations:', error)
  }
}

async function replayHandledJournal(path: string, ledger: ImportLedger): Promise<void> {
  let text: string
  try {
    text = await readFile(handledJournalPath(path), 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw error
  }
  const replayed = new Map<string, Set<string>>()
  for (const raw of text.split('\n')) {
    let line: unknown
    try {
      line = raw.trim() ? JSON.parse(raw) : null
    } catch {
      continue
    }
    if (!isHandledJournalLine(line)) {
      continue
    }
    let source = ledger.sources[line.source]
    if (!source) {
      source = {
        identity: line.identity,
        handled: [],
        folders: {},
        ...(ledger.recovered ? { seeding: true as const } : {})
      }
      ledger.sources[line.source] = source
    }
    let names = replayed.get(line.source)
    if (!names) {
      names = new Set(source.handled)
      replayed.set(line.source, names)
    }
    for (const name of line.handled) {
      names.add(name)
    }
  }
  for (const [key, names] of replayed) {
    ledger.sources[key].handled = [...names]
  }
  // The file is behind the journal until the next write folds it in.
  unsaved.add(path)
}
