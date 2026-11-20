import { randomUUID } from 'node:crypto'
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
  /** Accounts whose history has its copy, so a retry doesn't copy them again. */
  preservedAccounts?: string[]
  /** The shared history was created, or already existed, so nothing is owed. */
  historyImportSettled?: boolean
  historyImportAttempts?: number
  /** The account histories' sizes and times when the import last gave up. */
  historyImportInputs?: string
  historyImportGaveUpAt?: number
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
  if ('preservedAccounts' in parsed && Array.isArray(parsed.preservedAccounts)) {
    state.preservedAccounts = parsed.preservedAccounts.filter(
      (accountId): accountId is string => typeof accountId === 'string'
    )
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
