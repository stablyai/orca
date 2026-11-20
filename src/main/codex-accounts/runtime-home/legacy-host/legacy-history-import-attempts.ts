import {
  importLegacyHistoriesIfSharedAbsent,
  legacyHistoryInputsKey
} from './legacy-prompt-history-import'

/** Failed launches before the import waits for the account histories to change. */
export const MAX_HISTORY_IMPORT_ATTEMPTS = 3
/** How long a given-up import waits before trying again with unchanged account histories. */
export const HISTORY_IMPORT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

export type LegacyMigrationState = {
  completedAt?: number
  migratedHomeCount?: number
  historyImportAttempts?: number
  /** The account histories' sizes and times when the import last gave up. */
  historyImportInputs?: string
  historyImportGaveUpAt?: number
  /** The shared history was created, or already existed, so nothing is owed. */
  historyImportSettled?: boolean
}

export function parseLegacyMigrationState(text: string): LegacyMigrationState {
  const parsed: unknown = JSON.parse(text)
  const state: LegacyMigrationState = {}
  if (!parsed || typeof parsed !== 'object') {
    return state
  }
  if ('completedAt' in parsed && typeof parsed.completedAt === 'number') {
    state.completedAt = parsed.completedAt
  }
  if ('migratedHomeCount' in parsed && typeof parsed.migratedHomeCount === 'number') {
    state.migratedHomeCount = parsed.migratedHomeCount
  }
  if ('historyImportAttempts' in parsed && typeof parsed.historyImportAttempts === 'number') {
    state.historyImportAttempts = parsed.historyImportAttempts
  }
  if ('historyImportInputs' in parsed && typeof parsed.historyImportInputs === 'string') {
    state.historyImportInputs = parsed.historyImportInputs
  }
  if ('historyImportSettled' in parsed && typeof parsed.historyImportSettled === 'boolean') {
    state.historyImportSettled = parsed.historyImportSettled
  }
  if ('historyImportGaveUpAt' in parsed && typeof parsed.historyImportGaveUpAt === 'number') {
    state.historyImportGaveUpAt = parsed.historyImportGaveUpAt
  }
  return state
}

/** Where the import reads and writes, and how its attempts are recorded. */
export type LegacyHistoryImportTarget = {
  accountsRoot: string
  runtimeHistoryPath: string
  writeState: (state: LegacyMigrationState) => void
}

/** Off the startup path; never rejects. */
export async function attemptLegacyHistoryImport(
  target: LegacyHistoryImportTarget
): Promise<boolean> {
  try {
    await importLegacyHistoriesIfSharedAbsent(target.accountsRoot, target.runtimeHistoryPath)
    return true
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
    return false
  }
}

/**
 * After a few failed launches, a change to the account histories or a day's wait earns another
 * attempt, so a failure that clears (permissions, a mount) still imports.
 */
export async function retryLegacyHistoryImport(
  target: LegacyHistoryImportTarget,
  state: LegacyMigrationState
): Promise<void> {
  if ((state.historyImportAttempts ?? 0) >= MAX_HISTORY_IMPORT_ATTEMPTS) {
    const inputs = await legacyHistoryInputsKey(target.accountsRoot).catch(() => null)
    if (inputs !== null && inputs !== state.historyImportInputs) {
      state = { ...state, historyImportAttempts: 0 }
    } else if (Date.now() - (state.historyImportGaveUpAt ?? 0) < HISTORY_IMPORT_RETRY_INTERVAL_MS) {
      return
    } else {
      state = { ...state, historyImportAttempts: MAX_HISTORY_IMPORT_ATTEMPTS - 1 }
    }
  }
  await recordLegacyHistoryImport(target, state, await attemptLegacyHistoryImport(target))
}

export async function recordLegacyHistoryImport(
  target: LegacyHistoryImportTarget,
  state: LegacyMigrationState,
  imported: boolean
): Promise<void> {
  try {
    if (imported) {
      target.writeState({ ...state, historyImportSettled: true })
      return
    }
    const attempts = (state.historyImportAttempts ?? 0) + 1
    const gaveUp = attempts >= MAX_HISTORY_IMPORT_ATTEMPTS
    const historyImportInputs = gaveUp
      ? await legacyHistoryInputsKey(target.accountsRoot).catch(() => undefined)
      : undefined
    target.writeState({
      ...state,
      historyImportAttempts: attempts,
      historyImportInputs,
      historyImportGaveUpAt: gaveUp ? Date.now() : undefined
    })
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to record legacy Codex history import:', error)
  }
}
