import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKTREE_SLEEP_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'sleep'],
  summary: 'Put a worktree to sleep, stopping its terminals and agents',
  usage: 'orca worktree sleep --worktree <selector> [--force] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force'],
  notes: [
    'Same as Sleep in the sidebar: terminals, browser tabs and agents in the worktree stop, and slept agents resume when the worktree is opened again. The checkout and its files are untouched.',
    'With the desktop app open, success means Orca accepted the sleep; the app finishes it right after. A headless runtime returns only after every terminal is confirmed stopped, and fails with terminal_worktree_sleep_unverified otherwise.',
    'Sleeping the worktree whose terminal runs this command would stop that terminal too, so it is refused unless --force is passed.'
  ],
  examples: [
    'orca worktree sleep --worktree branch:feature/login',
    'orca worktree sleep --worktree path:/Users/me/orca/workspaces/orca/cli-test-1 --json'
  ]
}
