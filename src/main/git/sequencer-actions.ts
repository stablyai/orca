import { editorSuppressedGitEnv } from '../../shared/git-sequencer-editor-env'
import {
  gitSequencerAdvanced,
  gitSequencerContinueStep,
  type GitSequencerOperation
} from '../../shared/git-sequencer-step'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

async function readSequencerMarkerOid(
  marker: string,
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '-q', '--verify', marker],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Advances an in-progress merge/rebase/cherry-pick by one step. */
export async function continueSequencer(
  operation: GitSequencerOperation,
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  const { args, marker } = gitSequencerContinueStep(operation)
  const markerBefore = await readSequencerMarkerOid(marker, worktreePath, options)
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync([...args], {
        ...gitOptionsForWorktree(worktreePath, options),
        // Why: `--continue` opens the commit-message editor and would hang with no terminal to close it.
        env: editorSuppressedGitEnv()
      })
    )
  } catch (error) {
    const markerAfter = await readSequencerMarkerOid(marker, worktreePath, options)
    if (!gitSequencerAdvanced(markerBefore, markerAfter)) {
      throw error
    }
    // The sequencer advanced, but git still said something; losing it entirely hides hook failures.
    console.warn(
      `[git/sequencer] \`git ${args.join(' ')}\` advanced ${marker} to ${markerAfter} but exited nonzero:`,
      error
    )
  }
}
