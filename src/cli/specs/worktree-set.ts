import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKTREE_SET_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'set'],
  summary: 'Update Orca metadata for a worktree',
  usage:
    'orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--linear-issue <identifier-or-url|null>] [--comment <text>] [--workspace-status <id>] [--url <url|null>] [--parent-worktree <selector>|--no-parent] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'display-name',
    'issue',
    'linear-issue',
    'comment',
    'workspace-status',
    'url',
    'parent-worktree',
    'no-parent'
  ],
  notes: [
    'Pass --url <link> to save a link for the workspace (e.g. https://app.test/admin); the card and status bar open and copy it. --url null clears it.',
    'Workspace status ids match the board columns (defaults: todo, in-progress, in-review, completed); custom statuses use their configured id.',
    'Pass --linear-issue null to clear the Linear issue link.'
  ],
  examples: [
    'orca worktree set --worktree active --linear-issue STA-335 --json',
    'orca worktree set --worktree active --linear-issue null --json',
    'orca worktree set --worktree active --url https://app.test/admin --json'
  ]
}
