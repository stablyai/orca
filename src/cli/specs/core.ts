import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { SERVE_COMMAND_SPECS } from './serve'

export const CORE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['open'],
    summary: 'Launch MCode and wait for the runtime to be reachable',
    usage: 'mcode open [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['mcode open', 'mcode open --json']
  },
  ...SERVE_COMMAND_SPECS,
  {
    path: ['status'],
    summary: 'Show app/runtime/graph readiness',
    usage: 'mcode status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['mcode status', 'mcode status --json']
  },
  {
    path: ['claude-teams'],
    argumentMode: 'passthrough',
    summary: 'Start Claude Code Agent Teams in the current MCode terminal',
    usage: 'mcode claude-teams [claude args...]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Passes all following arguments through to Claude Code after enabling Agent Teams native panes.',
      'Must be run from inside an MCode terminal. Starts Claude Code Agent Teams in the current pane and opens teammates as native MCode splits.'
    ],
    examples: ['mcode claude-teams', 'mcode claude-teams --resume <session-id>']
  },
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in MCode',
    usage: 'mcode repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to MCode by filesystem path',
    usage: 'mcode repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'mcode repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'mcode repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'mcode repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
  {
    path: ['worktree', 'list'],
    summary: 'List MCode-managed worktrees',
    usage: 'mcode worktree list [--repo <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'limit']
  },
  {
    path: ['worktree', 'show'],
    summary: 'Show one worktree',
    usage: 'mcode worktree show --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['worktree', 'current'],
    summary: 'Show the MCode-managed worktree for the current directory',
    usage: 'mcode worktree current [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Resolves the current shell directory to a path: selector so agents can target the enclosing MCode worktree without spelling out $PWD.'
    ],
    examples: ['mcode worktree current', 'mcode worktree current --json']
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a new MCode-managed worktree',
    usage:
      'mcode worktree create --name <name> [--repo <selector>|--project <id> [--host <host-id>]|--project-host-setup <id>] [--agent <id>] [--prompt <text>] [--setup run|skip|inherit] [--base-branch <ref>] [--issue <number>] [--linear-issue <identifier-or-url>] [--comment <text>] [--parent-worktree <selector>] [--no-parent] [--run-hooks] [--activate] [--json]',
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
      'This creates a new checkout. For a fresh agent in an existing worktree, use `mcode terminal create --worktree active --command "codex"` instead.',
      'By default, MCode records the new worktree as a child of the caller context when it can infer one from the MCode terminal or current directory.',
      'If --repo is omitted, MCode infers the repo from the current MCode-managed worktree.',
      'Use --project with --host to create on a ready project host setup without spelling the backing repo id.',
      '--host runtime:<environment-id> creates on that paired MCode server; use the id from `mcode environment list`, not the environment name.',
      'For related work, use the inferred parent or pass --parent-worktree active, folder:<id>, or worktree:<worktreeId> to make the relationship explicit. Worktree ids are the full <repo-id>::<path> values returned by `mcode worktree list --json`.',
      'Use --no-parent when the new worktree should be independent of the current context.',
      '--no-parent only affects MCode lineage; omit --base-branch to use the repo default base, or pass the default base ref explicitly for independent top-level work.',
      'By default this creates the worktree and its first terminal without switching the active MCode view.',
      'Pass --agent to launch an agent in the first terminal; --prompt sends initial work to that agent.',
      'With --agent --json, read the new agent handle from result.agentTerminalHandle; older runtimes return only result.startupTerminal.handle, and may return neither for folder-based repos.',
      'Repo-defined setup hooks follow the repository setup policy; pass --setup run to force them.',
      'Pass --activate when the CLI caller intentionally wants to reveal the new worktree in the app.',
      'Passing --run-hooks is kept as a legacy alias for --setup run and reveals the worktree.'
    ],
    examples: [
      'mcode worktree create --name agent-task --agent codex --prompt "hi" --json',
      'mcode worktree create --repo id:<repoId> --name related-task --json',
      'mcode worktree create --project github:mcode-ide/mcode --host runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3 --name benchmark --json',
      'mcode worktree create --repo id:<repoId> --name linear-task --linear-issue https://linear.app/stably/issue/STA-335/test-issue --json',
      'mcode worktree create --repo id:<repoId> --name agent-task --agent codex --prompt "hi" --json',
      'mcode worktree create --repo id:<repoId> --name folder-child --parent-worktree folder:<folderId> --json',
      'mcode worktree create --repo id:<repoId> --name related-task --parent-worktree active --json',
      'mcode worktree create --repo id:<repoId> --name independent-task --no-parent --json'
    ]
  },
  {
    path: ['worktree', 'set'],
    summary: 'Update MCode metadata for a worktree',
    usage:
      'mcode worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--linear-issue <identifier-or-url|null>] [--comment <text>] [--workspace-status <id>] [--parent-worktree <selector>|--no-parent] [--json]',
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
      'mcode worktree set --worktree active --linear-issue STA-335 --json',
      'mcode worktree set --worktree active --linear-issue null --json'
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
    summary: 'Remove a worktree from MCode and git',
    usage: 'mcode worktree rm --worktree <selector> [--force] [--run-hooks] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force', 'run-hooks'],
    notes: ['Repo-defined mcode.yaml archive hooks are skipped unless --run-hooks is passed.']
  },
  {
    path: ['worktree', 'ps'],
    summary: 'Show a compact orchestration summary across worktrees',
    usage: 'mcode worktree ps [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  {
    path: ['terminal', 'list'],
    summary: 'List live MCode-managed terminals',
    usage:
      'mcode terminal list [--worktree <selector>] [--limit <n>] [--include-visual-layouts] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit', 'include-visual-layouts'],
    notes: [
      'JSON omits visualLayouts by default; pass --include-visual-layouts when machine-readable tab and pane topology is required.'
    ]
  },
  {
    path: ['terminal', 'show'],
    summary: 'Show terminal metadata and preview',
    usage: 'mcode terminal show [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'read'],
    summary: 'Read bounded terminal output',
    usage:
      'mcode terminal read [--terminal <handle>] [--cursor <n>] [--limit <n>] [--screen] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'cursor', 'limit', 'screen'],
    notes: [
      'Omit --terminal to target the active terminal in the current worktree.',
      'By default this returns accumulated terminal output with escape sequences stripped, not the rendered screen. Any program that repaints a line — shells, progress bars, TUIs — comes back as stacked fragments, so one `clear` keystroke by keystroke reads as `cclclecleaclear`, and spaces a prompt draws by moving the cursor are absent.',
      'Use --screen to read what the terminal actually renders. Prefer it whenever the answer depends on how output looks rather than what was emitted over time; the default is unsuitable for verifying rendered output.',
      'The result reports source: stream when it is accumulated output, screen when it is the rendered screen, and screen-unavailable when a screen was asked for but none could be rendered and the accumulated output is being returned instead. An absent source means the host predates the field.',
      '--screen and --cursor are mutually exclusive: a screen read is the current frame and has no history to page.',
      'Use --cursor with the nextCursor value from a previous read to get only new output since that read.',
      'Use --limit to request more retained lines for long agent responses; output reports oldestCursor when older lines were dropped.',
      'Useful for capturing the response to a command: read before sending, then read --cursor <prev> after waiting.'
    ],
    examples: [
      'mcode terminal read --json',
      'mcode terminal read --terminal term_abc123 --cursor 42 --limit 1000 --json',
      'mcode terminal read --terminal term_abc123 --screen --json'
    ]
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input to a live terminal',
    usage:
      'mcode terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'text', 'enter', 'interrupt']
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Wait for a terminal condition',
    usage:
      'mcode terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'for', 'timeout-ms']
  },
  {
    path: ['terminal', 'stop'],
    summary: 'Stop terminals for a worktree',
    usage: 'mcode terminal stop --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['terminal', 'create'],
    summary: 'Create a terminal session in the current worktree',
    usage:
      'mcode terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'command', 'title', 'focus'],
    notes: [
      'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
      'Use this, not worktree create, for a fresh agent in the current checkout.'
    ],
    examples: [
      'mcode terminal create --json',
      'mcode terminal create --worktree active --command "codex" --json',
      'mcode terminal create --worktree path:/projects/myapp --title "RUNNER" --command "opencode"',
      'mcode terminal create --worktree path:/projects/myapp --command "opencode" --focus'
    ]
  },
  {
    path: ['terminal', 'switch'],
    // Why: `focus` is the legacy verb for this action; keep it working as an
    // alias rather than a duplicate spec + handler registration.
    aliases: [['terminal', 'focus']],
    summary: 'Switch to a terminal tab in the UI',
    usage: 'mcode terminal switch [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['mcode terminal switch --terminal term_abc123']
  },
  {
    path: ['terminal', 'close'],
    summary: 'Close a terminal pane/session, or its whole tab with --tab',
    usage: 'mcode terminal close [--terminal <handle>] [--tab] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'tab'],
    notes: [
      'Without --tab, preserves the existing pane/session close behavior. With --tab, waits until the whole tab is durably removed.'
    ],
    examples: [
      'mcode terminal close --terminal term_abc123',
      'mcode terminal close --terminal term_abc123 --tab --json'
    ]
  },
  {
    path: ['terminal', 'rename'],
    summary: 'Set or clear the title of a terminal tab',
    usage: 'mcode terminal rename [--terminal <handle>] [--title <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title'],
    notes: ['Omit --title or pass an empty string to reset to the auto-generated title.'],
    examples: [
      'mcode terminal rename --terminal term_abc123 --title "RUNNER"',
      'mcode terminal rename --terminal term_abc123 --json'
    ]
  },
  {
    path: ['terminal', 'split'],
    summary: 'Split an existing terminal pane',
    usage:
      'mcode terminal split [--terminal <handle>] [--direction horizontal|vertical] [--command <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'direction', 'command'],
    examples: [
      'mcode terminal split --terminal term_abc123 --direction horizontal --json',
      'mcode terminal split --terminal term_abc123 --command "codex"'
    ]
  }
]
