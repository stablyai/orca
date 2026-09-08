const SEARCH_FLAG_HELP: Record<string, string> = {
  'agent-session': '--agent-session <query> Text to find in any coding-agent session (required)',
  agent: '--agent <agent>        Only this agent (claude, codex, cursor, …); repeatable',
  path: '--path <dir>           Only sessions whose working directory is under this path; repeatable',
  since: '--since <iso>          Only sessions updated at or after this ISO 8601 timestamp',
  newest: '--newest               Sort by session time instead of relevance',
  host: '--host <host>          Search a paired runtime host (runtime:<environment>)'
}

export function formatSearchFlagHelp(command: string, flag: string): string | null {
  return command === 'search' ? (SEARCH_FLAG_HELP[flag] ?? null) : null
}
