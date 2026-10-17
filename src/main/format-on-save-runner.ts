import {
  isFormatOnSaveConfigured,
  matchesFormatOnSaveInclude,
  type FormatOnSaveResult
} from '../shared/format-on-save-command'
import { executeFormatCommand } from './format-on-save-process'
import { FORMAT_ON_SAVE_TIMEOUT_MS } from './format-on-save-timeout'

export { FORMAT_ON_SAVE_TIMEOUT_MS }
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import { resolveFormatTarget } from './format-on-save-file-containment'
import { stableInFlightKey } from '../shared/in-flight-promise-dedupe'
import type { RepoFormatOnSaveSettings } from '../shared/repo-types'

export type FormatOnSaveRequest = {
  settings: RepoFormatOnSaveSettings | undefined | null
  worktreePath: string
  absoluteFilePath: string
}

// Why: autosave fires on a short debounce and a formatter rewrites the file it
// is reading; overlapping runs on one path race each other's output.
const inFlightPaths = new Set<string>()

export async function runFormatOnSave({
  settings,
  worktreePath,
  absoluteFilePath: requestedFilePath
}: FormatOnSaveRequest): Promise<FormatOnSaveResult> {
  if (!isFormatOnSaveConfigured(settings) || !settings) {
    return { status: 'skipped', reason: 'not-configured' }
  }

  const target = await resolveFormatTarget({
    worktreePath,
    absoluteFilePath: requestedFilePath
  })
  if (target === null) {
    // Why: the command runs with the worktree as cwd, so a file outside it has no meaningful ${relativeFile}.
    return { status: 'skipped', reason: 'outside-worktree' }
  }
  const { absolutePath: absoluteFilePath, relativePath } = target

  if (!matchesFormatOnSaveInclude(relativePath, settings.include)) {
    return { status: 'skipped', reason: 'not-included' }
  }

  // Why: use the comparison form so Windows' case-insensitive paths share one
  // in-flight slot. POSIX paths are left case-sensitive on purpose — folding them
  // would treat two genuinely different files as one.
  const inFlightKey = stableInFlightKey([normalizeRuntimePathForComparison(absoluteFilePath)])
  if (inFlightPaths.has(inFlightKey)) {
    return { status: 'skipped', reason: 'already-running' }
  }

  inFlightPaths.add(inFlightKey)
  try {
    return await executeFormatCommand({
      command: settings.command,
      worktreePath,
      absoluteFilePath,
      relativePath
    })
  } finally {
    inFlightPaths.delete(inFlightKey)
  }
}

export function _resetFormatOnSaveInFlightForTests(): void {
  inFlightPaths.clear()
}
