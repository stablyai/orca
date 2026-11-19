import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'

/** One import folder's day folder (or `archived_sessions`) as last read. */
export type ImportedFolder = {
  /** Its mtime when read; absent while it still needs another read. */
  mtimeNs?: string
}

export type ImportedSource = {
  /** `dev:ino` of the import folder; a replaced folder starts over. */
  identity: string
  /**
   * Rollout names (without `.zst`) already linked or found in the store, wherever they sit in the import folder
   * now (Codex archives by moving): never linked again, so one the user deleted stays deleted.
   */
  handled: string[]
  folders: Record<string, ImportedFolder>
  /** Set after a damaged ledger: passes only record names until one reads every folder. */
  seeding?: true
}

type ImportLedger = {
  version: 1
  sources: Record<string, ImportedSource>
  /** Read from a damaged file: its record of handled names is lost, so a full pass only seeds it. */
  recovered?: true
}

function emptyLedger(): ImportLedger {
  return { version: 1, sources: {} }
}

function isImportedSource(value: unknown): value is ImportedSource {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const source = value as Partial<ImportedSource>
  return (
    typeof source.identity === 'string' &&
    (source.seeding === undefined || source.seeding === true) &&
    Array.isArray(source.handled) &&
    source.handled.every((name) => typeof name === 'string') &&
    typeof source.folders === 'object' &&
    source.folders !== null &&
    Object.values(source.folders).every(
      (folder) => folder?.mtimeNs === undefined || typeof folder.mtimeNs === 'string'
    )
  )
}

// Parsed once per run: only this process writes the ledger, and every import keeps it current.
const loaded = new Map<string, Promise<ImportLedger>>()

/**
 * A missing ledger starts empty. A damaged one starts empty and `recovered`: which conversations
 * the user deleted is lost with it, so nothing already in an import folder is linked again.
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
    const parsed = JSON.parse(text) as Partial<ImportLedger>
    if (parsed.version !== 1 || typeof parsed.sources !== 'object' || parsed.sources === null) {
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
    return damaged ? { version: 1, sources, recovered: true } : { version: 1, sources }
  } catch {
    console.warn(`[codex-history-import] Damaged ledger ${path}; importing only new conversations`)
    return { ...emptyLedger(), recovered: true }
  }
}

export async function writeImportLedger(path: string, ledger: ImportLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    const { recovered: _recovered, ...saved } = ledger
    await writeFile(temporary, JSON.stringify(saved))
    await renameFileWithWindowsRetryAsync(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
