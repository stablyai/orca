import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS, type CommandSpec } from '../args'

// Terminal login lets headless hosts manage accounts without the desktop login UI.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed agent account by signing in on this Orca host',
    usage:
      'orca account add [--agent claude|codex|opencode|devin] [--label <name>] [--integration <id>] [--method <id>] [--answer <key=value>]... [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'label', 'integration', 'method', 'answer'],
    repeatableFlags: ['answer'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local Orca runtime.',
      'Codex uses device authorization so the browser can complete sign-in from a different machine.',
      'OpenCode 2 uses `opencode auth login --standalone` in private XDG directories. Devin uses `devin auth login --force-manual-token-flow`.',
      'Use --integration <id> to skip the OpenCode integration picker; --label names the saved OpenCode or Devin profile.',
      'Use --method <id> and repeated --answer <key=value> to pass OpenCode its login method and form answers, so sign-in can finish without an interactive terminal.',
      'OpenCode and Devin profiles apply to new explicit host agent launches. Direct SSH relay and Windows-hosted WSL selection are not supported; run the command on a headless Orca runtime on that host.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the Orca runtime to be running on this machine.'
    ],
    examples: [
      'orca account add',
      'orca account add --agent codex',
      'orca account add --agent opencode --integration github-copilot --method <id> --answer <key=value>'
    ]
  },
  {
    path: ['account', 'list'],
    summary: 'List managed agent accounts on an Orca host',
    usage: 'orca account list [--agent opencode|devin] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    examples: ['orca account list', 'orca account list --environment homelab']
  },
  {
    path: ['account', 'select'],
    summary: 'Select a Claude account or an OpenCode or Devin profile for new agent launches',
    usage: 'orca account select --agent claude|opencode|devin --account <id|system> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'account'],
    notes: [
      'Account IDs come from `orca account list --json`. `system` selects System default instead of a managed account.',
      'For Claude, an open Orca window on that host handles running sessions with its "When you switch accounts while Claude is running in terminals" setting.'
    ],
    examples: ['orca account select --agent claude --account system']
  },
  {
    path: ['account', 'rm'],
    aliases: [['account', 'remove']],
    destructive: true,
    summary: 'Remove a managed OpenCode or Devin profile and its private data',
    usage: 'orca account rm --agent opencode|devin --account <id> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account'],
    notes: [
      'Deletes credentials and conversation data in the managed profile. Stop its running agents first. System credentials are never removed.'
    ]
  }
]
