// Why: these handlers throw on either selection flag (rejectRemoteSelectionFlags) instead of routing.
const REJECTED_REMOTE_SELECTION_HELP: Record<string, string> = {
  'pairing-code': '--pairing-code <code>  Rejected; this command only runs on this machine',
  environment: '--environment <selector> Rejected; this command only runs on this machine'
}

const REMOTE_SELECTION_REJECTING_COMMANDS = [
  'environment list',
  'host list',
  'account add',
  'account list',
  'artifacts list',
  'artifacts share',
  'artifacts update',
  'artifacts unshare',
  'artifacts delete',
  'profile state exports',
  'profile state rollback',
  'agent hooks prepare-codex',
  'agent hooks status',
  'agent hooks off',
  'agent hooks on'
]

/** Per-command flag help, kept out of the shared help chain it would crowd. */
const COMMAND_SCOPED_FLAG_HELP: Record<string, Record<string, string>> = {
  ...Object.fromEntries(
    REMOTE_SELECTION_REJECTING_COMMANDS.map((command) => [command, REJECTED_REMOTE_SELECTION_HELP])
  ),
  // Why: these commands read or write this machine's pairing store, so the global routing meaning would be wrong.
  'environment add': {
    'pairing-code':
      '--pairing-code <code>  orca://pair?... code of the remote Orca runtime to save',
    environment: '--environment <selector> Not used; the environment is saved on this machine'
  },
  'environment show': {
    'pairing-code': '--pairing-code <code>  Not used; reads the environments saved on this machine',
    environment: '--environment <selector> Saved environment id or name to show'
  },
  'environment rm': {
    'pairing-code':
      '--pairing-code <code>  Not used; removes from the environments saved on this machine',
    environment: '--environment <selector> Saved environment id or name to remove'
  },
  'skills get': {
    full: '--full                 Print the full guide with bundled references',
    reference: '--reference <name>     Print one bundled reference by name',
    references: '--references           List the bundled reference names for a topic'
  },
  'skills install': {
    agent: '--agent <names>        Comma-separated install targets; default is detected agents'
  },
  search: {
    query: '--query <text>         Search text; also accepted as the positional argument',
    scope: '--scope <corpus>       conversation (user and assistant turns) or all (default)',
    fresh: '--fresh                Wait up to 5s for the host to reconcile its index first',
    limit: '--limit <n>            Hits per page (default 20, maximum 100)',
    cursor: '--cursor <cursor>      Opaque cursor printed by the previous page of this search',
    agent: '--agent <id>           Restrict to one agent; repeat for several',
    path: '--path <path>          Restrict to an execution-host path; repeat for several',
    since: '--since <iso>          Only sessions updated at or after this ISO 8601 timestamp',
    sort: '--sort <order>         relevance (default) or newest',
    debug: '--debug                Include the planner route the host used',
    'index-status': '--index-status         Report the index instead of searching'
  }
}

export function formatCommandScopedFlagHelp(command: string, flag: string): string | undefined {
  return COMMAND_SCOPED_FLAG_HELP[command]?.[flag]
}
