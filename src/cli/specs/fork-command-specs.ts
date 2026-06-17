import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FORK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['fork'],
    summary: 'Fork an agent session from a terminal or provider session',
    usage:
      'orca fork [--terminal <handle>] [--message <id>] [--worktree <selector> --agent <id> --provider-session <id> [--provider-session-key session_id|conversation_id|session_path]] [--name <label>] [--activate] [--no-copy-files] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'worktree',
      'agent',
      'provider-session',
      'provider-session-key',
      'message',
      'name',
      'activate',
      'no-copy-files'
    ],
    notes: [
      'Creates a child workspace with parent-child lineage and starts a new agent with the best available provider-native, structured-history, or transcript context.',
      'When --terminal is omitted, Orca uses the active terminal when the runtime can resolve one.',
      '--message forks from a structured hook message id when Orca has recorded prompt history for the terminal or provider session.',
      'Use --worktree, --agent, and --provider-session together to fork from a retained provider session when no source terminal is live. If the provider CLI has no native fork command, Orca uses recorded prompt history when available.',
      '--provider-session-key defaults to session_id. Use session_path for Pi session-file forks.',
      '--no-copy-files starts the fork in the source workspace without copying files or creating child workspace lineage.'
    ],
    examples: [
      'orca fork --terminal term_abc123 --name investigate-auth --activate --json',
      'orca fork --terminal term_abc123 --message opencode-message-msg-1 --name before-refactor --json',
      'orca fork --worktree id:<worktreeId> --agent claude --provider-session <session-id> --name investigate-auth --json',
      'orca fork --worktree id:<worktreeId> --agent gemini --provider-session <session-id> --name retained-context --json',
      'orca fork --worktree id:<worktreeId> --agent claude --provider-session <session-id> --message claude-message-1 --json',
      'orca fork --json'
    ]
  },
  {
    path: ['fork', 'list'],
    summary: 'List session forks',
    usage: 'orca fork list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['fork', 'show'],
    summary: 'Show one session fork',
    usage: 'orca fork show <fork-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'fork'],
    positionalArgs: ['fork']
  },
  {
    path: ['fork', 'diff'],
    summary: 'Show a fork child workspace diff against its parent',
    usage: 'orca fork diff <fork-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'fork'],
    positionalArgs: ['fork'],
    notes: [
      'The patch includes tracked working-tree changes in the child workspace. Untracked files are listed separately.'
    ]
  },
  {
    path: ['fork', 'rm'],
    summary: 'Remove a session fork child workspace',
    usage: 'orca fork rm <fork-id> [--force] [--run-hooks] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'fork', 'force', 'run-hooks'],
    positionalArgs: ['fork']
  }
]
