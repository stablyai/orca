import { statSync, type Stats } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { readAgentStateFileSync } from '../agent-state-file-reader'

// Distinguish unreadable from absent before mutations; existsSync collapses both to false.
export type CodexPathObservation<T> =
  | { kind: 'present'; value: T }
  | { kind: 'absent' }
  | { kind: 'indeterminate'; error: unknown }

/** Only ENOENT/ENOTDIR prove absence; all other failures remain indeterminate. */
export function observe<T>(read: () => T): CodexPathObservation<T> {
  try {
    return { kind: 'present', value: read() }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'indeterminate', error }
  }
}

// Read once to avoid existence-check/read races.
export function observeAgentStateFile(filePath: string): CodexPathObservation<string> {
  return observe(() => readAgentStateFileSync(filePath))
}

/** Follow symlinks while preserving unreadable-versus-absent outcomes. */
export function observeResolvedPathEntry(entryPath: string): CodexPathObservation<Stats> {
  return observe(() => statSync(entryPath))
}
