/**
 * Commands whose `--worktree` still names a git worktree only.
 *
 * Everything else merely scopes a workspace — browser tabs, terminals, emulators, computer-use,
 * `worktree show` — and resolves a Folder Workspace as readily as a git worktree. These read or
 * mutate the git worktree record itself, so `folder:<id>` has nothing to name for them.
 */
const GIT_ONLY_WORKTREE_SELECTOR_COMMANDS = new Set([
  'worktree set',
  'worktree rm',
  'terminal stop',
  'terminal close',
  'file open',
  'file diff',
  'file open-changed',
  'orchestration worker-start',
  'orchestration coordinator-start'
])

/** Per-flag help for the workspace-scoped `--worktree`, kept out of the help chain it would crowd. */
export function formatWorktreeSelectorFlagHelp(command: string, flag: string): string | undefined {
  return flag === 'worktree' && !GIT_ONLY_WORKTREE_SELECTOR_COMMANDS.has(command)
    ? '--worktree <selector>  Workspace selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, path:<path>, folder:<id>, or active/current'
    : undefined
}
