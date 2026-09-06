import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const CHROME_DEVTOOLS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chrome-devtools', 'session'],
    summary: 'Keep a Chrome DevTools MCP session open for sequential JSONL requests',
    usage: 'orca chrome-devtools session [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca chrome-devtools session'],
    notes: [
      'Reads one JSON object per stdin line and emits one compact JSON response per line. Requests: {id:1,type:"tools"} or {id:2,type:"call",tool:"list_pages",arguments:{}}. The session preserves selected pages and snapshot UIDs until stdin closes. Each MCP request times out after 120 seconds. Run directly on the execution host.'
    ]
  },
  {
    path: ['chrome-devtools', 'tools'],
    summary: 'List Chrome DevTools MCP tools and their complete input schemas',
    usage: 'orca chrome-devtools tools [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca chrome-devtools tools --json'],
    notes: ['Runs Chrome DevTools MCP on this host through npx; the first run may download it.']
  },
  {
    path: ['chrome-devtools', 'call'],
    summary: 'Call one Chrome DevTools MCP tool on this host',
    usage: 'orca chrome-devtools call --tool <name> [--arguments-file <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'tool', 'arguments-file'],
    examples: ['orca chrome-devtools call --tool list_pages --json'],
    notes: [
      'Arguments must be a JSON object. Each invocation creates a new MCP session; selected pages and snapshot UIDs do not persist. Browser access requires Chrome remote debugging and its Allow prompt. Never routes through a remote Orca host.'
    ]
  }
]
