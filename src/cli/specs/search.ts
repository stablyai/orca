import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Status is a flag because a subcommand would collide with searching for the word "status".
export const SEARCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['search'],
    summary: 'Search the full text of agent sessions indexed on the selected Orca server',
    usage:
      'orca search <query> [--scope conversation|all] [--fresh] [--limit <n>] [--cursor <c>] [--agent <id>] [--path <p>] [--since <iso>] [--sort relevance|newest] [--debug] [--json]\n  orca search --index-status [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'query',
      'scope',
      'fresh',
      'limit',
      'cursor',
      'agent',
      'path',
      'since',
      'sort',
      'debug',
      'index-status'
    ],
    repeatableFlags: ['agent', 'path'],
    positionalArgs: ['query'],
    notes: [
      'Searches one server: the Orca on this computer, or the server named by --server / --pairing-code. There is no all-servers search.',
      'In an Orca SSH terminal, the forwarded CLI searches the controlling Orca server by default. Use --server / --pairing-code to select another server; --path only filters results on the selected runtime.',
      'Quote a multi-word query, or pass it as --query "<text>"; unquoted words are read as command names.',
      '--scope conversation and --scope all (the default) search user and assistant turns; tool output is excluded.',
      '--fresh waits up to five seconds for the server to reconcile its index before searching, then searches anyway.',
      '--agent and --path may be repeated. --path is a literal path on the server and is not expanded or resolved against the current directory.',
      '--since takes an ISO 8601 timestamp with an offset, for example 2026-08-01T00:00:00Z.',
      '--limit is per page (default 20, maximum 100). Pass the printed cursor back with --cursor to read the next page.',
      'A cursor belongs to one query on one server. Change the query, the filters, or the server and the cursor stops being valid.',
      'Resume commands and source paths are printed only for the Orca on this computer; another server withholds them.',
      '--json prints the runtime response envelope with the search contract answer under `result`.'
    ],
    examples: [
      'orca search "strict mode violation getByRole"',
      'orca search resolveTerminalPath --agent claude --sort newest',
      'orca search "kernel panic" --path /Users/me/orca --since 2026-08-01T00:00:00Z --json',
      'orca search "kernel panic" --limit 50 --cursor eyJ2IjoxfQ',
      'orca search --index-status',
      'orca search "flaky test" --server build-server'
    ]
  }
]
