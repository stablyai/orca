import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { track } from '../../../telemetry/client'
import type { CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES } from '../../../../shared/telemetry/schemas/telemetry-codex-legacy-history-event-schemas'

type LegacyHistoryImportOutcome = (typeof CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES)[number]

/** Launches that try the import before it gives up; the kept copies stay either way. */
const MAX_IMPORT_ATTEMPTS = 3
const IMPORT_STATE_FILE = 'import-state.json'

type ImportState = { done: boolean; attempts: number }

async function readImportState(path: string): Promise<ImportState> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (error) {
    // Unreadable (not missing) state never re-imports: Orca couldn't record a later outcome either.
    return { done: errnoCodeOrUnknown(error) !== 'ENOENT', attempts: 0 }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return {
        done: 'done' in parsed && parsed.done === true,
        attempts: 'attempts' in parsed && typeof parsed.attempts === 'number' ? parsed.attempts : 0
      }
    }
  } catch {
    // Retried below: the import itself never writes into an existing shared history.
  }
  return { done: false, attempts: 0 }
}

// Temp then rename: never torn, and a link at the name is replaced rather than written through.
async function writeImportState(path: string, state: ImportState): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, `${JSON.stringify(state)}\n`, { encoding: 'utf-8', flag: 'wx' })
    await rename(tmpPath, path)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

/**
 * Seeds a missing shared history from Orca's kept copies, once: each launch tries until the import
 * settles or has failed three times. Nothing runs while there are no kept copies.
 */
export async function importKeptLegacyHistoriesOnce(
  keptRoot: string,
  runtimeHistoryPath: string
): Promise<void> {
  const statePath = join(keptRoot, IMPORT_STATE_FILE)
  const state = await readImportState(statePath)
  if (state.done) {
    return
  }
  let keptPaths: string[]
  let outcome: LegacyHistoryImportOutcome
  try {
    keptPaths = await listKeptLegacyHistories(keptRoot)
    if (keptPaths.length === 0) {
      return
    }
    outcome = await publishKeptLegacyHistoriesIfAbsent(keptPaths, runtimeHistoryPath)
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to list kept legacy Codex prompt history:', error)
    outcome = 'failed'
  }
  trackLegacyHistoryImport(outcome)
  const attempts = state.attempts + 1
  const next: ImportState = {
    done: outcome !== 'failed' || attempts >= MAX_IMPORT_ATTEMPTS,
    attempts
  }
  await writeImportState(statePath, next)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

// Every kept copy, accounts and their preserved versions in a stable order.
async function listKeptLegacyHistories(keptRoot: string): Promise<string[]> {
  const paths: string[] = []
  const accounts = await readdir(keptRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return []
    }
    throw error
  })
  for (const account of accounts.filter((entry) => entry.isDirectory()).sort(byName)) {
    const files = await readdir(join(keptRoot, account.name), { withFileTypes: true })
    for (const file of files.filter((entry) => entry.isFile()).sort(byName)) {
      if (file.name.endsWith('.jsonl')) {
        paths.push(join(keptRoot, account.name, file.name))
      }
    }
  }
  return paths
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * Codex may be appending to or trimming a shared history.jsonl that exists, so only a missing one is
 * created from Orca's kept copies, and never over one Codex creates meanwhile.
 */
async function publishKeptLegacyHistoriesIfAbsent(
  keptPaths: readonly string[],
  runtimeHistoryPath: string
): Promise<LegacyHistoryImportOutcome> {
  try {
    if (await pathExists(runtimeHistoryPath)) {
      return 'skipped_existing'
    }
    const seenLines = new Set<string>()
    for (const keptPath of keptPaths) {
      for (const line of (await readFile(keptPath, 'utf-8')).split('\n')) {
        if (line) {
          seenLines.add(line)
        }
      }
    }
    if (seenLines.size === 0) {
      return 'nothing_to_import'
    }
    return (await publishWithoutOverwrite(`${[...seenLines].join('\n')}\n`, runtimeHistoryPath))
      ? 'imported'
      : 'skipped_existing'
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
    return 'failed'
  }
}

async function publishWithoutOverwrite(contents: string, targetPath: string): Promise<boolean> {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // A hard link publishes only into a free name: one Codex created meanwhile stays as it is.
    await link(tmpPath, targetPath)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'EEXIST') {
      return false
    }
    throw error
  } finally {
    await rm(tmpPath, { force: true })
  }
}

function trackLegacyHistoryImport(outcome: LegacyHistoryImportOutcome): void {
  try {
    track('codex_legacy_history_import', {
      outcome,
      platform:
        process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin'
    })
  } catch {
    // Telemetry never costs the migration.
  }
}
