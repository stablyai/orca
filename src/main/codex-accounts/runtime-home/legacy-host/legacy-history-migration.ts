import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
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
  /** Accounts whose history has its copy, so a retry doesn't copy them again. */
  preservedAccounts?: string[]
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
  /** Written with the marker once the session pass finishes. */
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

/**
 * Exclusive create never replaces or writes through a name. A regular file already holding the same
 * bytes counts as the copy; a link there does not, since it isn't a copy of its own.
 */
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
    return (
      (await lstat(targetPath)).isFile() &&
      (await readFile(targetPath)).equals(await readFile(source))
    )
  } catch {
    return false
  }
}

// The shared history only when it is a regular file in the runtime home: an account history that
// is that file needs no copy, but one the shared history links to does.
async function sharedHistoryFile(runtimeHistoryPath: string): Promise<string | null> {
  const stats = await lstat(runtimeHistoryPath).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return null
    }
    throw error
  })
  return stats?.isFile() ? realpath(runtimeHistoryPath) : null
}

// Every account's own history, copied into the runtime home where no Orca path deletes it, so an
// older build's account removal can never take the only copy.
async function preserveLegacyHistories(
  accountsRoot: string,
  runtimeHistoryPath: string,
  alreadyPreserved: ReadonlySet<string>,
  recordPreserved: (accountId: string) => Promise<void>
): Promise<void> {
  const accounts = await readdir(accountsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return []
    }
    throw error
  })
  const sharedHistory = await sharedHistoryFile(runtimeHistoryPath)
  const copiedSources = new Set<string>()
  const names = accounts.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  for (const accountId of names.sort()) {
    if (alreadyPreserved.has(accountId)) {
      continue
    }
    const source = await realpathIfPresent(join(accountsRoot, accountId, 'home', 'history.jsonl'))
    if (!source || !(await stat(source)).isFile()) {
      continue
    }
    if (source !== sharedHistory && !copiedSources.has(source)) {
      const base = runtimeHistoryPath.replace(/\.jsonl$/, '')
      for (let attempt = 0; ; attempt++) {
        const suffix = attempt === 0 ? '' : `-${attempt}`
        if (await copyIntoFreeName(source, `${base}.orca-legacy-${accountId}${suffix}.jsonl`)) {
          break
        }
      }
      copiedSources.add(source)
    }
    await recordPreserved(accountId)
  }
}

// Repairs a marker lost to a crash right after the session pass.
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
 * Off the startup path. Preserves the account histories, then runs the session pass, which marks
 * the migration done for older builds, then imports the shared history until it settles. The
 * session pass waits for the copies so an older build never sees the marker while an account
 * history has no copy, and never sees copied sessions without the marker. Never rejects; whatever
 * fails retries on a later launch.
 */
export async function settleLegacyHistory(
  paths: LegacyHistoryMigrationPaths,
  migrateSessions: (() => void) | null
): Promise<void> {
  try {
    const text = await readTextIfPresent(paths.statePath)
    let state = text === null ? {} : parseLegacyHistoryState(text)
    if (!state.historiesPreserved) {
      const preserved = new Set(state.preservedAccounts)
      await preserveLegacyHistories(
        paths.accountsRoot,
        paths.runtimeHistoryPath,
        preserved,
        async (accountId) => {
          preserved.add(accountId)
          state = { ...state, preservedAccounts: [...preserved] }
          await writeTextAtomically(paths.statePath, `${JSON.stringify(state)}\n`)
        }
      )
      state = { ...state, historiesPreserved: true }
      await writeTextAtomically(paths.statePath, `${JSON.stringify(state)}\n`)
    }
    try {
      migrateSessions?.()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy Codex sessions:', error)
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
