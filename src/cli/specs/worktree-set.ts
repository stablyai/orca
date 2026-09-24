import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const WORKTREE_SET_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'set'],
  summary: 'Update Orca metadata for a worktree',
  usage:
    'orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--pr <number|null>] [--linear-issue <identifier-or-url|null>] [--gitlab-issue <number-or-url|null>] [--gitlab-mr <number-or-url|null>] [--comment <text>] [--workspace-status <id>] [--unread|--read] [--tag <name>]... [--untag <name>]... [--tags <a,b|null>] [--parent-worktree <selector> [--parent-environment <environment>]|--no-parent] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'display-name',
    'tag',
    'untag',
    'tags',
    'issue',
    'pr',
    'linear-issue',
    'gitlab-issue',
    'gitlab-mr',
    'comment',
    'workspace-status',
    'unread',
    'read',
    'parent-worktree',
    'parent-environment',
    'no-parent'
  ],
  notes: [
    'Workspace status ids match the board columns (defaults: todo, in-progress, in-review, completed); custom statuses use their configured id.',
    'Pass --comment "" (or --comment=) to clear the comment.',
    'Pass --linear-issue null to clear the Linear issue link.',
    "--parent-worktree is looked up in the worktree's own environment; add --parent-environment <local|environment-id> for a parent in another environment. No other environment is searched.",
    'Pass --pr null, --gitlab-issue null, or --gitlab-mr null to clear only the matching link.',
    'Each link flag updates its own field and leaves unrelated links unchanged. GitLab URLs must match the stored source project or remote; they cannot select a foreign project.',
    'On a folder workspace (folder:<id>, or a path:/name: selector that matches one), only --display-name, --comment, --workspace-status and --unread/--read apply. Parent and link flags are refused; link it with orca reference add.',
    'Tags group workspaces across repos in the sidebar. --tag and --untag repeat and keep the other tags; --tags replaces the whole set, and --tags null clears it. Tags match case-insensitively.'
  ],
  repeatableFlags: ['tag', 'untag'],
  examples: [
    'orca worktree set --worktree active --linear-issue STA-335 --json',
    'orca worktree set --worktree active --linear-issue null --json',
    'orca worktree set --worktree active --comment "" --json',
    'orca worktree set --worktree active --workspace-status in-review --unread --json',
    'orca worktree set --worktree active --tag billing --tag api --json',
    'orca worktree set --worktree active --tags null --json'
  ]
}
