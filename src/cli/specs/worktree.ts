import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKTREE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['worktree', 'list'],
    summary: 'List Orca-managed worktrees',
    usage: 'orca worktree list [--repo <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'limit']
  },
  {
    path: ['worktree', 'show'],
    summary: 'Show one worktree',
    usage: 'orca worktree show --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['worktree', 'current'],
    summary: 'Show the Orca-managed worktree for the current directory',
    usage: 'orca worktree current [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Resolves the current shell directory to a path: selector so agents can target the enclosing Orca worktree without spelling out $PWD.'
    ],
    examples: ['orca worktree current', 'orca worktree current --json']
  },
  {
    path: ['worktree', 'import'],
    summary: 'Reveal an existing worktree Orca did not create',
    usage: 'orca worktree import --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Records the resolved worktree path on its repo so the sidebar shows it. Nothing is created, moved, or checked out, and the worktree is not marked as Orca-created.',
      'Use this for durable worktrees a project or agent CLI already manages. Repo visibility sources such as the built-in .claude/worktrees source reveal a whole source at once; an import reveals one worktree, which is what makes it scriptable per checkout.',
      'Selectors resolve against worktrees git reports for a registered repo; an unknown path fails with selector_not_found.',
      'Only worktrees of a registered repo are eligible. An independent clone of the same upstream — its own .git directory rather than a linked worktree — is never reported as that repo\'s worktree, so there is nothing to reveal.',
      'active and current resolve to the enclosing visible worktree, so a hidden one cannot be addressed that way — pass the worktree absolute path; path:$PWD is a shorthand for POSIX shells and PowerShell only.',
      'Repeating the command is a no-op and reports already-imported.'
    ],
    examples: [
      'orca worktree import --worktree path:/repo/.claude/worktrees/task --json',
      'orca worktree import --worktree "path:$PWD" --json'
    ]
  },
  {
    path: ['worktree', 'unimport'],
    summary: 'Undo an import so the worktree follows the repo visibility rules',
    usage: 'orca worktree unimport --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Removes the path from the repo import list only. This changes visibility only and never deletes a checkout — use `orca worktree rm` for that.',
      'A worktree that is visible for another reason, such as the repo-wide non-Orca visibility setting, stays visible.'
    ],
    examples: ['orca worktree unimport --worktree path:/repo/.claude/worktrees/task --json']
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a new Orca-managed worktree',
    usage:
      'orca worktree create --name <name> [--repo <selector>|--project <id> [--host <host-id>]|--project-host-setup <id>] [--agent <id>] [--prompt <text>] [--setup run|skip|inherit] [--base-branch <ref>] [--issue <number>] [--linear-issue <identifier-or-url>] [--comment <text>] [--parent-worktree <selector>] [--no-parent] [--run-hooks] [--activate] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'repo',
      'project',
      'host',
      'project-host-setup',
      'name',
      'agent',
      'prompt',
      'base-branch',
      'issue',
      'linear-issue',
      'comment',
      'setup',
      'parent-worktree',
      'no-parent',
      'run-hooks',
      'activate'
    ],
    notes: [
      'This creates a new checkout. For a fresh agent in an existing worktree, use `orca terminal create --worktree active --command "codex"` instead.',
      'By default, Orca records the new worktree as a child of the caller context when it can infer one from the Orca terminal or current directory.',
      'If --repo is omitted, Orca infers the repo from the current Orca-managed worktree.',
      'Use --project with --host to create on a ready project host setup without spelling the backing repo id.',
      '--host runtime:<environment-id> creates on that paired Orca server; use the id from `orca environment list`, not the environment name.',
      'For related work, use the inferred parent or pass --parent-worktree active, folder:<id>, or worktree:<worktreeId> to make the relationship explicit. Worktree ids are the full <repo-id>::<path> values returned by `orca worktree list --json`.',
      'Use --no-parent when the new worktree should be independent of the current context.',
      '--no-parent only affects Orca lineage; omit --base-branch to use the repo default base, or pass the default base ref explicitly for independent top-level work.',
      'By default this creates the worktree and its first terminal without switching the active Orca view.',
      'Pass --agent to launch an agent in the first terminal; --prompt sends initial work to that agent.',
      'With --agent --json, read the new agent handle from result.agentTerminalHandle; older runtimes return only result.startupTerminal.handle, and may return neither for folder-based repos.',
      'Repo-defined setup hooks follow the repository setup policy; pass --setup run to force them.',
      'Pass --activate when the CLI caller intentionally wants to reveal the new worktree in the app.',
      'Passing --run-hooks is kept as a legacy alias for --setup run and reveals the worktree.'
    ],
    examples: [
      'orca worktree create --name agent-task --agent codex --prompt "hi" --json',
      'orca worktree create --repo id:<repoId> --name related-task --json',
      'orca worktree create --project github:stablyai/orca --host runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3 --name benchmark --json',
      'orca worktree create --repo id:<repoId> --name linear-task --linear-issue https://linear.app/stably/issue/STA-335/test-issue --json',
      'orca worktree create --repo id:<repoId> --name agent-task --agent codex --prompt "hi" --json',
      'orca worktree create --repo id:<repoId> --name folder-child --parent-worktree folder:<folderId> --json',
      'orca worktree create --repo id:<repoId> --name related-task --parent-worktree active --json',
      'orca worktree create --repo id:<repoId> --name independent-task --no-parent --json'
    ]
  },
  {
    path: ['worktree', 'set'],
    summary: 'Update Orca metadata for a worktree',
    usage:
      'orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--linear-issue <identifier-or-url|null>] [--comment <text>] [--workspace-status <id>] [--parent-worktree <selector>|--no-parent] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'worktree',
      'display-name',
      'issue',
      'linear-issue',
      'comment',
      'workspace-status',
      'parent-worktree',
      'no-parent'
    ],
    notes: [
      'Workspace status ids match the board columns (defaults: todo, in-progress, in-review, completed); custom statuses use their configured id.',
      'Pass --linear-issue null to clear the Linear issue link.'
    ],
    examples: [
      'orca worktree set --worktree active --linear-issue STA-335 --json',
      'orca worktree set --worktree active --linear-issue null --json'
    ]
  },
  {
    path: ['worktree', 'rm'],
    // Why: agents reach for git's `remove`/`delete` verbs; accept them as
    // aliases so a conventional guess resolves instead of dead-ending.
    aliases: [
      ['worktree', 'remove'],
      ['worktree', 'delete']
    ],
    destructive: true,
    summary: 'Remove a worktree from Orca and git',
    usage: 'orca worktree rm --worktree <selector> [--force] [--run-hooks] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force', 'run-hooks'],
    notes: [
      'Repo-defined orca.yaml archive hooks are skipped unless --run-hooks is passed.',
      'For Git worktrees, removal also attempts to delete the checked-out local branch, with or without --force. Orca retains branches it knows predated the worktree and any branch whose changes it cannot prove are already merged.'
    ]
  },
  {
    path: ['worktree', 'ps'],
    summary: 'Show a compact orchestration summary across worktrees',
    usage: 'orca worktree ps [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  }
]
