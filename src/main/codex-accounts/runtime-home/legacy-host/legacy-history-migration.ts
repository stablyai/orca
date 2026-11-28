import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import {
  importLegacyHistoriesIfSharedAbsent,
  legacyHistoryInputsKey
} from './legacy-prompt-history-import'

/** Failed launches before the import waits for the account histories to change. */
export const MAX_HISTORY_IMPORT_ATTEMPTS = 3
/** How long a given-up import waits before trying again with unchanged account histories. */
export const HISTORY_IMPORT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

export type LegacyHistoryState = {
  /** Failed session passes; after a few, the pass waits a day between tries. */
  sessionPassAttempts?: number
  sessionPassFailedAt?: number
  /** The shared history was created, or already existed, so nothing is owed. */
  historyImportSettled?: boolean
  historyImportAttempts?: number
  /** The account histories' sizes and times when the import last gave up. */
  historyImportInputs?: string
  historyImportGaveUpAt?: number
}

/** Like the import: a few tries, then once a day, so a lasting failure isn't redone every launch. */
export function legacySessionPassDue(state: LegacyHistoryState): boolean {
  return (
    (state.sessionPassAttempts ?? 0) < MAX_HISTORY_IMPORT_ATTEMPTS ||
    Date.now() - (state.sessionPassFailedAt ?? 0) >= HISTORY_IMPORT_RETRY_INTERVAL_MS
  )
}

export function recordLegacySessionPassFailure(state: LegacyHistoryState): LegacyHistoryState {
  return {
    ...state,
    sessionPassAttempts: (state.sessionPassAttempts ?? 0) + 1,
    sessionPassFailedAt: Date.now()
  }
}

/** Where the shared history import reads and records its attempts. */
export type LegacyHistoryImportPaths = {
  accountsRoot: string
  runtimeHistoryPath: string
  statePath: string
}

export function parseLegacyHistoryState(text: string): LegacyHistoryState {
  const parsed: unknown = JSON.parse(text)
  const state: LegacyHistoryState = {}
  if (!parsed || typeof parsed !== 'object') {
    return state
  }
  if ('sessionPassAttempts' in parsed && typeof parsed.sessionPassAttempts === 'number') {
    state.sessionPassAttempts = parsed.sessionPassAttempts
  }
  if ('sessionPassFailedAt' in parsed && typeof parsed.sessionPassFailedAt === 'number') {
    state.sessionPassFailedAt = parsed.sessionPassFailedAt
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
  // One fixed name, cleared first, so a quit mid-write leaves nothing behind for good.
  const tmpPath = `${path}.tmp`
  await rm(tmpPath, { force: true })
  try {
    await writeFile(tmpPath, text, { encoding: 'utf-8', flag: 'wx' })
    await rename(tmpPath, path)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

/**
 * After a few failed launches, a change to the account histories or a day's wait earns another
 * attempt, so a failure that clears (permissions, a mount) still imports.
 */
async function retryLegacyHistoryImport(
  paths: LegacyHistoryImportPaths,
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

/**
 * Off the startup path: imports the shared history until it settles, retrying on later launches.
 * Never rejects.
 */
export async function settleLegacyHistoryImport(paths: LegacyHistoryImportPaths): Promise<void> {
  try {
    const text = await readTextIfPresent(paths.statePath)
    const state = text === null ? {} : parseLegacyHistoryState(text)
    if (!state.historyImportSettled) {
      await retryLegacyHistoryImport(paths, state)
    }
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
  }
}
