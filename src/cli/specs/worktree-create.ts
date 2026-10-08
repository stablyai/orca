import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKTREE_CREATE_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'create'],
  summary: 'Create a new Orca-managed worktree',
  usage:
    'orca worktree create --name <name> [--repo <selector>|--project <id> [--host <host-id>]|--project-host-setup <id>] [--agent <id>] [--account <id|email>] [--prompt <text>] [--setup run|skip|inherit] [--base-branch <ref>] [--issue <number>] [--pr <number>] [--linear-issue <identifier-or-url>] [--gitlab-issue <number-or-url>] [--gitlab-mr <number-or-url>] [--comment <text>] [--parent-worktree <selector>] [--no-parent] [--run-hooks] [--activate] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'repo',
    'project',
    'host',
    'project-host-setup',
    'name',
    'agent',
    'account',
    'prompt',
    'base-branch',
    'issue',
    'pr',
    'linear-issue',
    'gitlab-issue',
    'gitlab-mr',
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
    '--account <id|email> (with --agent claude) starts Claude on that managed account from `orca account list` without switching the host account. Local host workspaces only.',
    'With --agent --json, read the new agent handle from result.agentTerminalHandle; older runtimes return only result.startupTerminal.handle, and may return neither for folder-based repos.',
    'Repo-defined setup hooks follow the repository setup policy; pass --setup run to force them.',
    'Pass --activate when the CLI caller intentionally wants to reveal the new worktree in the app.',
    'Passing --run-hooks is kept as a legacy alias for --setup run and reveals the worktree.',
    'Use --pr for GitHub pull requests; --gitlab-issue and --gitlab-mr write separate GitLab links. GitLab URLs must match the stored source project or remote; they cannot select a foreign project.'
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
}
