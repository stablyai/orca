import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SEARCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['search'],
    summary: 'Search the full text of every local coding-agent session',
    usage:
      'orca search --agent-session "<query>" [--limit <n>] [--agent <agent>] [--path <dir>] [--since <iso>] [--newest] [--host <host>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'agent-session',
      'limit',
      'agent',
      'path',
      'since',
      'newest',
      'host'
    ],
    notes: [
      'Searches what you typed, what the agent said, the commands it ran, and the first 3 KB of each tool output across Claude Code, Codex, Cursor, Gemini, OpenCode, and the other agents Orca scans.',
      'Quote paths, identifiers, or error text to match them exactly; plain words match anywhere. A misspelled word is repaired from the index vocabulary when nothing matches.',
      '--agent-session takes the query. --agent and --path may repeat. --since takes an ISO timestamp. --newest sorts by session time instead of relevance.',
      'The index builds in the background on first use; the result reports how many sessions are covered so far.',
      '--host runtime:<environment> searches that host; the index always lives with the transcripts.'
    ],
    examples: [
      'orca search --agent-session "strict mode violation getByRole"',
      'orca search --agent-session resolveTerminalPath --agent claude --newest',
      'orca search --agent-session "kernel panic" --path ~/orca --since 2026-08-01T00:00:00Z --json'
    ]
  }
]
