import { statSync, type Stats } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { readAgentStateFileSync } from '../agent-state-file-reader'

/**
 * A filesystem read either answered, definitively answered "not there", or
 * failed to answer at all.
 *
 * `existsSync` collapses the last two into `false`, and a `catch` that returns a
 * default collapses them into the default. That is how a held lock comes to
 * authorise an overwrite or a delete: the caller reads "this file is not there"
 * from evidence that says only "I could not look".
 */
export type CodexPathObservation<T> =
  | { kind: 'present'; value: T }
  | { kind: 'absent' }
  | { kind: 'indeterminate'; error: unknown }

/**
 * Classify any read. Only `ENOENT`/`ENOTDIR` are absence — every other errno,
 * including unrecognised ones, is indeterminate. Mapping an unknown errno to a
 * verdict is the category error this module exists to prevent.
 */
export function observe<T>(read: () => T): CodexPathObservation<T> {
  try {
    return { kind: 'present', value: read() }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'indeterminate', error }
  }
}

/** Why: one call replaces the `existsSync` + read pair, closing its TOCTOU window too. */
export function observeAgentStateFile(filePath: string): CodexPathObservation<string> {
  return observe(() => readAgentStateFileSync(filePath))
}

/**
 * `stat`, so a symlink resolves to its target — the same reachability question
 * `existsSync` answers, but with the failure kept distinct from the absence.
 */
export function observeResolvedPathEntry(entryPath: string): CodexPathObservation<Stats> {
  return observe(() => statSync(entryPath))
}
