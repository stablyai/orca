import { GLOBAL_FLAGS, type CommandSpec } from '../args'

/** The one vocabulary the parser and `parseSearchCommand` both read from. */
export const SEARCH_BOOLEAN_FLAGS = [
  'enable',
  'disable',
  'clear-index',
  'index-status',
  'pause',
  'resume-indexing',
  'newest'
] as const

export const SEARCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['search'],
    summary: 'Search the full text of coding-agent sessions on local and remote hosts',
    usage:
      'orca search --agent-session "<query>" [--limit <n>] [--agent <agent>] [--path <dir>] [--since <iso>] [--newest] [--host <host>] [--json]\n  orca search --agent-session --enable [--host <host>]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'agent-session',
      'limit',
      'agent',
      'path',
      'since',
      'newest',
      'host',
      'enable',
      'disable',
      'clear-index',
      'index-status',
      'history-days',
      'pause',
      'resume-indexing'
    ],
    booleanFlags: [...SEARCH_BOOLEAN_FLAGS],
    repeatableFlags: ['agent', 'path'],
    notes: [
      'Searches what you typed, what the agent said, the commands it ran, and the first 3 KB of each tool output across Claude Code, Codex, Cursor, Gemini, OpenCode, and the other agents Orca scans.',
      'Quote paths, identifiers, or error text to match them exactly; plain words match anywhere. A misspelled word is repaired from the index vocabulary when nothing matches.',
      '--agent-session takes the query. --agent and --path may repeat. --since takes an ISO timestamp. --newest sorts by session time instead of relevance.',
      'Transcript search is off until you turn it on. Enable it in Settings > Agent Session History, or run `orca search --agent-session --enable`.',
      'The index builds in the background once enabled; the result reports how many sessions are covered so far.',
      '--host runtime:<environment> selects a paired server; --host ssh:<target> selects a connected SSH host. Use --environment B --host ssh:<target> for SSH controlled by B. The index stays on the execution host.',
      '--host all queries this runtime, locally saved pairings and its connected SSH targets. With a remote environment selected, it queries only that runtime and its direct connected SSH targets. It never connects SSH or enables indexing.',
      '--limit is per host (default 20, maximum 100). Results are grouped by host; failures and incomplete coverage are reported. Aliased connections may return the same sessions.',
      '--path is a literal host-native predicate, with no implicit current-directory scope. SSH/all require absolute paths; use quoted Windows paths where appropriate. Remote/all do not expand ~.',
      'Index management requires one host: --enable, --disable, --history-days <1..3650|all>, --pause, --resume-indexing, --clear-index, or --index-status. Status cannot be combined with a query or mutation.',
      'Plain SSH uses the account’s default agent homes and Node.js 22.13+ with FTS5. Background indexing yields between bounded windows and pauses when the scanner retires after 10 idle minutes; a later search resumes it.'
    ],
    examples: [
      'orca search --agent-session "strict mode violation getByRole"',
      'orca search --agent-session resolveTerminalPath --agent claude --newest',
      'orca search --agent-session "kernel panic" --path ~/orca --since 2026-08-01T00:00:00Z --json',
      'orca search --agent-session --enable',
      'orca search --agent-session "kernel panic" --host all',
      'orca search --enable --host ssh:build-server',
      'orca search --index-status --host ssh:build-server',
      'orca search --disable --clear-index --host runtime:build-server',
      'orca search --agent-session "kernel panic" --environment B --host ssh:C'
    ]
  }
]
