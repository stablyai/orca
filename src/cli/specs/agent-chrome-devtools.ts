import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const AGENT_CHROME_DEVTOOLS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'chrome-devtools', 'setup'],
    summary: 'Configure Chrome DevTools MCP for supported agents on this host',
    usage:
      'orca agent chrome-devtools setup --agent <codex|opencode|gemini|pi|all> [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'dry-run'],
    examples: [
      'orca agent chrome-devtools setup --agent all --dry-run',
      'orca agent chrome-devtools setup --agent all'
    ],
    notes: [
      'all selects Codex, OpenCode v1, Gemini, and Pi; all prerequisites must pass before any file is written. Pi requires an installed compatible npm:pi-mcp-adapter extension. Writes canonical global config with a backup; never starts Chrome or downloads MCP packages. Run directly on the agent execution host; remote selectors are unsupported. Restart agent sessions after setup.'
    ]
  },
  {
    path: ['agent', 'chrome-devtools', 'status'],
    summary: 'Check canonical Chrome DevTools MCP configuration without changing it',
    usage: 'orca agent chrome-devtools status --agent <codex|opencode|gemini|pi|all> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    examples: ['orca agent chrome-devtools status --agent all'],
    notes: [
      'Checks configuration only; MCP handshake and browser connectivity are not checked. Codex validation requires its installed CLI and uses temporary config files.'
    ]
  }
]
