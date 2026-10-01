import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKTREE_SET_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'set'],
  summary: 'Update Orca metadata for a worktree',
  usage:
    'orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--linear-issue <identifier-or-url|null>] [--comment <text>] [--workspace-status <id>] [--tag <name>]... [--untag <name>]... [--tags <a,b|null>] [--parent-worktree <selector>|--no-parent] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'display-name',
    'tag',
    'untag',
    'tags',
    'issue',
    'linear-issue',
    'comment',
    'workspace-status',
    'parent-worktree',
    'no-parent'
  ],
  notes: [
    'Workspace status ids match the board columns (defaults: todo, in-progress, in-review, completed); custom statuses use their configured id.',
    'Pass --linear-issue null to clear the Linear issue link.',
    'Tags group workspaces across repos in the sidebar. --tag and --untag repeat and keep the other tags; --tags replaces the whole set, and --tags null clears it. Tags match case-insensitively.'
  ],
  repeatableFlags: ['tag', 'untag'],
  examples: [
    'orca worktree set --worktree active --linear-issue STA-335 --json',
    'orca worktree set --worktree active --linear-issue null --json',
    'orca worktree set --worktree active --tag billing --tag api --json',
    'orca worktree set --worktree active --tags null --json'
  ]
}
