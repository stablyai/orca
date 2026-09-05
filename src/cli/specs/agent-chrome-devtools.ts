import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const AGENT_CHROME_DEVTOOLS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'chrome-devtools', 'setup'],
    summary: 'Configure Chrome DevTools MCP for Codex or OpenCode on this host',
    usage: 'orca agent chrome-devtools setup --agent <codex|opencode|all> [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'dry-run'],
    examples: [
      'orca agent chrome-devtools setup --agent all --dry-run',
      'orca agent chrome-devtools setup --agent all'
    ],
    notes: [
      'Writes canonical global config with a backup; never starts Chrome or downloads MCP packages. Run directly on the agent execution host; remote selectors are unsupported. Restart agent sessions after setup.'
    ]
  },
  {
    path: ['agent', 'chrome-devtools', 'status'],
    summary: 'Check canonical Chrome DevTools MCP configuration without changing it',
    usage: 'orca agent chrome-devtools status --agent <codex|opencode|all> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    examples: ['orca agent chrome-devtools status --agent all'],
    notes: [
      'Checks configuration only; MCP handshake and browser connectivity are not checked. Codex validation requires its installed CLI and uses temporary config files.'
    ]
  }
]
