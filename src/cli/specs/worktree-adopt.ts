import { workspacePrCopy } from '../../shared/orchestration/workspace-pr-copy'
import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
export const WORKTREE_ADOPT_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'adopt'],
  summary: workspacePrCopy.summary,
  usage: workspacePrCopy.usage,
  notes: [
    `--path: ${workspacePrCopy.pathHelp}`,
    `--parent-worktree: ${workspacePrCopy.parentHelp}`
  ],
  allowedFlags: [...CLI_GLOBAL_FLAGS, 'path', 'parent-worktree']
}
