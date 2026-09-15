import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SCOPE_FLAGS = ['repo', 'worktree']

export const QUICK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['quick-command', 'list'],
    summary: 'List saved terminal quick commands',
    usage:
      'orca quick-command list [--repo <selector>|--worktree <selector>] [--scope all|global|repo|applicable] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'scope'],
    notes: [
      'Without a repo or worktree the default scope is all; with one it is applicable (global plus that repo).',
      'Use --scope repo to see only the commands saved against that workspace repo.'
    ],
    examples: [
      'orca quick-command list --json',
      'orca quick-command list --worktree active --scope repo --json'
    ]
  },
  {
    path: ['quick-command', 'show'],
    summary: 'Show one saved quick command',
    usage: 'orca quick-command show --id <quick-command-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['orca quick-command show --id quick-command-2f1c --json']
  },
  {
    path: ['quick-command', 'create'],
    summary: 'Create a terminal quick command',
    usage:
      'orca quick-command create --label <text> (--command <text> | --agent <id> --prompt <text>) [--repo <selector>|--worktree <selector>] [--no-enter] [--id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...SCOPE_FLAGS,
      'label',
      'command',
      'agent',
      'prompt',
      'no-enter',
      'id'
    ],
    notes: [
      'Omitting --repo and --worktree saves a global quick command available in every workspace.',
      '--no-enter types the command into the terminal without submitting it, and applies to --command only.',
      '--agent with --prompt creates an agent-prompt quick command instead of a shell command.'
    ],
    examples: [
      'orca quick-command create --label "Run tests" --command "pnpm test" --worktree active --json',
      'orca quick-command create --label "Review diff" --agent claude --prompt "review the working tree diff" --json'
    ]
  },
  {
    path: ['quick-command', 'set'],
    summary: 'Update a saved quick command',
    usage:
      'orca quick-command set --id <quick-command-id> [--label <text>] [--command <text>] [--agent <id>] [--prompt <text>] [--enter|--no-enter] [--repo <selector>|--worktree <selector>|--global] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...SCOPE_FLAGS,
      'id',
      'label',
      'command',
      'agent',
      'prompt',
      'enter',
      'no-enter',
      'global'
    ],
    notes: [
      'Scope only moves when --repo, --worktree, or --global is passed.',
      'Passing --command on an agent-prompt command converts it to a shell command, and --agent converts it back.',
      'Body flags for the other action are rejected, so --prompt on a shell command fails instead of being ignored.'
    ],
    examples: [
      'orca quick-command set --id quick-command-2f1c --command "pnpm test --run"',
      'orca quick-command set --id quick-command-2f1c --global --json'
    ]
  },
  {
    path: ['quick-command', 'rm'],
    destructive: true,
    summary: 'Remove a saved quick command',
    usage: 'orca quick-command rm --id <quick-command-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['orca quick-command rm --id quick-command-2f1c --json']
  }
]
