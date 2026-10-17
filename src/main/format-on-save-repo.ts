import {
  isFormatOnSaveConfigured,
  normalizeRepoFormatOnSaveSettings,
  type FormatOnSaveResult
} from '../shared/format-on-save-command'
import { getRepoExecutionHostId, parseExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { runFormatOnSave } from './format-on-save-runner'

/**
 * Formats one saved file with the repo's own configured command, on this process's host.
 *
 * The command is read from the repo record, never from the caller — otherwise the
 * caller would be an arbitrary-command-execution channel. A repo owned by another
 * host is skipped, not run here: a remote host formats through its own server.
 */
export async function runRepoFormatOnSave({
  repo,
  worktreePath,
  absoluteFilePath
}: {
  repo: Pick<Repo, 'formatOnSave' | 'connectionId' | 'executionHostId'>
  worktreePath: string
  absoluteFilePath: string
}): Promise<FormatOnSaveResult> {
  const settings = normalizeRepoFormatOnSaveSettings(repo.formatOnSave)
  if (!isFormatOnSaveConfigured(settings)) {
    return { status: 'skipped', reason: 'not-configured' }
  }

  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host && host.kind !== 'local') {
    return { status: 'skipped', reason: 'unsupported-host' }
  }

  return runFormatOnSave({ settings, worktreePath, absoluteFilePath })
}
