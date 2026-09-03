import { statSync, type Stats } from 'node:fs'
import { observe, type FilesystemObservation } from '../../shared/filesystem-observation'
import { readAgentStateFileSync } from '../agent-state-file-reader'

/** Why: one call replaces the `existsSync` + read pair, closing its TOCTOU window too. */
export function observeAgentStateFile(filePath: string): FilesystemObservation<string> {
  return observe(() => readAgentStateFileSync(filePath))
}

/**
 * `stat`, so a symlink resolves to its target — the same reachability question
 * `existsSync` answers, but with the failure kept distinct from the absence.
 */
export function observeResolvedPathEntry(entryPath: string): FilesystemObservation<Stats> {
  return observe(() => statSync(entryPath))
}
