import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { TERMINAL_COMMAND_SPECS } from './terminal-command-specs'

export const CORE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['open'],
    summary: 'Launch Orca and wait for the runtime to be reachable',
    usage: 'orca open [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca open', 'orca open --json']
  },
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'port', 'pairing-address', 'mobile-pairing', 'no-pairing'],
    notes: [
      'Runs in the foreground and prints the runtime endpoint. Stop it with Ctrl+C.',
      'Use --pairing-address when clients should connect through a LAN, Tailscale, SSH-forward, or public tunnel address.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  },
  {
    path: ['status'],
    summary: 'Show app/runtime/graph readiness',
    usage: 'orca status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca status', 'orca status --json']
  },
  {
    path: ['claude-teams'],
    summary: 'Start Claude Code Agent Teams in the current Orca terminal',
    usage: 'orca claude-teams [claude args...]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Passes all following arguments through to Claude Code after enabling Agent Teams native panes.',
      'Must be run from inside an Orca terminal. Starts Claude Code Agent Teams in the current pane and opens teammates as native Orca splits.'
    ],
    examples: ['orca claude-teams', 'orca claude-teams --resume <session-id>']
  },
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Orca',
    usage: 'orca repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Orca by filesystem path',
    usage: 'orca repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
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
      'By default, Orca records the new worktree as a child of the caller workspace when it can infer one from the Orca terminal or current directory.',
      'If --repo is omitted, Orca infers the repo from the current Orca-managed worktree.',
      'Use --project with --host to create on a ready project host setup without spelling the backing repo id.',
      'For related work, use the inferred parent or pass --parent-worktree active to make the current workspace relationship explicit.',
      'Use --no-parent when the new worktree should be independent of the current workspace.',
      'By default this creates the worktree and its first terminal without switching the active Orca workspace.',
      'Pass --agent to launch an agent in the first terminal; --prompt sends initial work to that agent.',
      'Repo-defined setup hooks follow the repository setup policy; pass --setup run to force them.',
      'Pass --activate when the CLI caller intentionally wants to reveal the new worktree in the app.',
      'Passing --run-hooks is kept as a legacy alias for --setup run and reveals the worktree.'
    ],
    examples: [
      'orca worktree create --name agent-task --agent codex --prompt "hi" --json',
      'orca worktree create --repo id:<repoId> --name related-task --json',
      'orca worktree create --project github:stablyai/orca --host runtime:gpu --name benchmark --json',
      'orca worktree create --repo id:<repoId> --name linear-task --linear-issue https://linear.app/stably/issue/STA-335/test-issue --json',
      'orca worktree create --repo id:<repoId> --name agent-task --agent codex --prompt "hi" --json',
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
    summary: 'Remove a worktree from Orca and git',
    usage: 'orca worktree rm --worktree <selector> [--force] [--run-hooks] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force', 'run-hooks'],
    notes: ['Repo-defined orca.yaml archive hooks are skipped unless --run-hooks is passed.']
  },
  {
    path: ['worktree', 'ps'],
    summary: 'Show a compact orchestration summary across worktrees',
    usage: 'orca worktree ps [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  ...TERMINAL_COMMAND_SPECS
]
