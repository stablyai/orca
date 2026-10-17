import type { FormatOnSaveResult } from '../../../shared/format-on-save-command'
import { runRepoFormatOnSave } from '../../format-on-save-repo'
import { assertRuntimeFileMutationExpectation } from './file-mutation-expectation'
import { requireLocalRuntimeFileRoute, resolveFileExplorerPath } from './file-target'
import type { RuntimeFileCommandHost } from './file-command-host'

type RuntimeFileFormattingHost = Pick<
  RuntimeFileCommandHost,
  'requireStore' | 'resolveRuntimeFileTarget'
>

export class RuntimeFileFormatting {
  constructor(private readonly host: RuntimeFileFormattingHost) {}

  /**
   * Formats a file the client just wrote, with the formatter command this server holds for the
   * repo. The command is never taken from the caller, and it runs on this host only.
   */
  async formatFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<FormatOnSaveResult> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    // Why: an `ssh:`/`runtime:` target throws here instead of running the command on this host.
    requireLocalRuntimeFileRoute(target)
    const repo = this.host.requireStore().getRepo(target.worktree.repoId)
    if (!repo) {
      return { status: 'skipped', reason: 'not-configured' }
    }
    return runRepoFormatOnSave({
      repo,
      worktreePath: target.worktree.path,
      absoluteFilePath: target.path
    })
  }
}
