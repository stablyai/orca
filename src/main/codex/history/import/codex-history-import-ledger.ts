import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'

/** One import folder's day folder (or `archived_sessions`) as last read. */
export type ImportedFolder = {
  /** Its mtime when read; absent while it still needs another read. */
  mtimeNs?: string
  /** Rollout names (without `.zst`) already linked or found in the store; never linked again. */
  handled: string[]
}

export type ImportedSource = {
  /** `dev:ino` of the import folder; a replaced folder starts over. */
  identity: string
  folders: Record<string, ImportedFolder>
}

type ImportLedger = { version: 1; sources: Record<string, ImportedSource> }

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
    typeof source.folders === 'object' &&
    source.folders !== null &&
    Object.values(source.folders).every(
      (folder) =>
        Array.isArray(folder?.handled) &&
        folder.handled.every((name) => typeof name === 'string') &&
        (folder.mtimeNs === undefined || typeof folder.mtimeNs === 'string')
    )
  )
}

/** An unreadable or unknown ledger starts over: a full pass re-checks every name against the store. */
export async function readImportLedger(path: string): Promise<ImportLedger> {
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
      return emptyLedger()
    }
    const sources: Record<string, ImportedSource> = {}
    for (const [key, source] of Object.entries(parsed.sources)) {
      if (isImportedSource(source)) {
        sources[key] = source
      }
    }
    return { version: 1, sources }
  } catch {
    return emptyLedger()
  }
}

export async function writeImportLedger(path: string, ledger: ImportLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(ledger))
    await renameFileWithWindowsRetryAsync(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
