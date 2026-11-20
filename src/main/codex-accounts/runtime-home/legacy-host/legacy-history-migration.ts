import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import {
  importLegacyHistoriesIfSharedAbsent,
  legacyHistoryInputsKey
} from './legacy-prompt-history-import'

/** Failed launches before the import waits for the account histories to change. */
export const MAX_HISTORY_IMPORT_ATTEMPTS = 3
/** How long a given-up import waits before trying again with unchanged account histories. */
export const HISTORY_IMPORT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

type LegacyHistoryState = {
  /** Every account history has a copy in the runtime home. */
  historiesPreserved?: boolean
  /** The shared history was created, or already existed, so nothing is owed. */
  historyImportSettled?: boolean
  historyImportAttempts?: number
  /** The account histories' sizes and times when the import last gave up. */
  historyImportInputs?: string
  historyImportGaveUpAt?: number
}

/** Where the legacy history migration reads and records its work. */
export type LegacyHistoryMigrationPaths = {
  accountsRoot: string
  runtimeHistoryPath: string
  statePath: string
  /** Written once the session pass finishes; its contents become the migration marker. */
  sessionsStatePath: string
  /** The only marker older builds read. */
  markerPath: string
}

function parseLegacyHistoryState(text: string): LegacyHistoryState {
  const parsed: unknown = JSON.parse(text)
  const state: LegacyHistoryState = {}
  if (!parsed || typeof parsed !== 'object') {
    return state
  }
  if ('historiesPreserved' in parsed && parsed.historiesPreserved === true) {
    state.historiesPreserved = true
  }
  if ('historyImportSettled' in parsed && parsed.historyImportSettled === true) {
    state.historyImportSettled = true
  }
  if ('historyImportAttempts' in parsed && typeof parsed.historyImportAttempts === 'number') {
    state.historyImportAttempts = parsed.historyImportAttempts
  }
  if ('historyImportInputs' in parsed && typeof parsed.historyImportInputs === 'string') {
    state.historyImportInputs = parsed.historyImportInputs
  }
  if ('historyImportGaveUpAt' in parsed && typeof parsed.historyImportGaveUpAt === 'number') {
    state.historyImportGaveUpAt = parsed.historyImportGaveUpAt
  }
  return state
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writeTextAtomically(path: string, text: string): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, text, { encoding: 'utf-8', flag: 'wx' })
    await rename(tmpPath, path)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

/** Exclusive create never replaces or writes through a name; same bytes there count as copied. */
async function copyIntoFreeName(source: string, targetPath: string): Promise<boolean> {
  try {
    await copyFile(source, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) !== 'EEXIST') {
      throw error
    }
  }
  try {
    return (await readFile(targetPath)).equals(await readFile(source))
  } catch {
    // A dangling link or directory at this name still occupies it.
    return false
  }
}

// Every account's own history, copied into the runtime home where no Orca path deletes it, so an
// older build's account removal can never take the only copy.
async function preserveLegacyHistories(
  accountsRoot: string,
  runtimeHistoryPath: string
): Promise<void> {
  const accounts = await readdir(accountsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return []
    }
    throw error
  })
  const sharedHistory = await realpathIfPresent(runtimeHistoryPath)
  const preserved = new Set<string>()
  const names = accounts.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  for (const accountId of names.sort()) {
    const source = await realpathIfPresent(join(accountsRoot, accountId, 'home', 'history.jsonl'))
    if (!source || source === sharedHistory || preserved.has(source)) {
      continue
    }
    if (!(await stat(source)).isFile()) {
      continue
    }
    preserved.add(source)
    const base = runtimeHistoryPath.replace(/\.jsonl$/, '')
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt}`
      if (await copyIntoFreeName(source, `${base}.orca-legacy-${accountId}${suffix}.jsonl`)) {
        break
      }
    }
  }
}

async function writeMarkerOnceSessionsDone(paths: LegacyHistoryMigrationPaths): Promise<void> {
  const sessionsState = await readTextIfPresent(paths.sessionsStatePath)
  if (sessionsState === null) {
    return
  }
  try {
    await access(paths.markerPath)
  } catch {
    await writeTextAtomically(paths.markerPath, sessionsState)
  }
}

/**
 * Off the startup path. Preserves the account histories, then marks the migration done for older
 * builds (once the session pass also finished), then imports the shared history until it settles.
 * Never rejects; whatever fails retries on a later launch.
 */
export async function settleLegacyHistory(paths: LegacyHistoryMigrationPaths): Promise<void> {
  try {
    const text = await readTextIfPresent(paths.statePath)
    let state = text === null ? {} : parseLegacyHistoryState(text)
    if (!state.historiesPreserved) {
      await preserveLegacyHistories(paths.accountsRoot, paths.runtimeHistoryPath)
      state = { ...state, historiesPreserved: true }
      await writeTextAtomically(paths.statePath, `${JSON.stringify(state)}\n`)
    }
    await writeMarkerOnceSessionsDone(paths)
    if (!state.historyImportSettled) {
      await retryLegacyHistoryImport(paths, state)
    }
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to migrate legacy Codex prompt history:', error)
  }
}

/**
 * After a few failed launches, a change to the account histories or a day's wait earns another
 * attempt, so a failure that clears (permissions, a mount) still imports.
 */
async function retryLegacyHistoryImport(
  paths: LegacyHistoryMigrationPaths,
  state: LegacyHistoryState
): Promise<void> {
  if ((state.historyImportAttempts ?? 0) >= MAX_HISTORY_IMPORT_ATTEMPTS) {
    const inputs = await legacyHistoryInputsKey(paths.accountsRoot).catch(() => null)
    if (inputs !== null && inputs !== state.historyImportInputs) {
      state = { ...state, historyImportAttempts: 0 }
    } else if (Date.now() - (state.historyImportGaveUpAt ?? 0) < HISTORY_IMPORT_RETRY_INTERVAL_MS) {
      return
    } else {
      state = { ...state, historyImportAttempts: MAX_HISTORY_IMPORT_ATTEMPTS - 1 }
    }
  }
  try {
    await importLegacyHistoriesIfSharedAbsent(paths.accountsRoot, paths.runtimeHistoryPath)
    state = { ...state, historyImportSettled: true }
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
    const attempts = (state.historyImportAttempts ?? 0) + 1
    const gaveUp = attempts >= MAX_HISTORY_IMPORT_ATTEMPTS
    state = {
      ...state,
      historyImportAttempts: attempts,
      historyImportInputs: gaveUp
        ? await legacyHistoryInputsKey(paths.accountsRoot).catch(() => undefined)
        : undefined,
      historyImportGaveUpAt: gaveUp ? Date.now() : undefined
    }
  }
  await writeTextAtomically(paths.statePath, `${JSON.stringify(state)}\n`)
}
