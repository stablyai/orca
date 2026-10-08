import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why one command and not a `search status` subcommand: the query is a bare
// positional, so `orca search status` would be indistinguishable from searching
// for the word "status". The index report is a flag on the same command instead.
export const SEARCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['search'],
    summary: 'Search the full text of agent sessions indexed on the selected Orca host',
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
      'Searches one host: this machine, or the paired Orca server named by --environment / --pairing-code. There is no all-computers search.',
      'In an Orca SSH terminal, the forwarded CLI searches the controlling Orca runtime by default. Use --environment / --pairing-code to select a paired server; --path only filters results on the selected runtime.',
      'Quote a multi-word query, or pass it as --query "<text>"; unquoted words are read as command names.',
      '--scope conversation searches user and assistant turns only; --scope all (the default) also searches commands and tool output.',
      '--fresh waits up to five seconds for the host to reconcile its index before searching, then searches anyway.',
      '--agent and --path may be repeated. --path is a literal execution-host path and is not expanded or resolved against the current directory.',
      '--since takes an ISO 8601 timestamp with an offset, for example 2026-08-01T00:00:00Z.',
      '--limit is per page (default 20, maximum 100). Pass the printed cursor back with --cursor to read the next page.',
      'A cursor belongs to one query on one host. Change the query, the filters, or the host and the cursor stops being valid.',
      'Resume commands and source paths are printed only for a host on this machine; a paired server withholds them.',
      '--json prints the runtime response envelope with the search contract answer under `result`.'
    ],
    examples: [
      'orca search "strict mode violation getByRole"',
      'orca search resolveTerminalPath --agent claude --sort newest',
      'orca search "kernel panic" --path /Users/me/orca --since 2026-08-01T00:00:00Z --json',
      'orca search "kernel panic" --limit 50 --cursor eyJ2IjoxfQ',
      'orca search --index-status',
      'orca search "flaky test" --environment build-server'
    ]
  }
]
