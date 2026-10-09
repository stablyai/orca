// Why: the shared --focus line describes terminal create's terminal session.
const FILE_OPEN_FOCUS_HELP =
  "--focus                Bring the user to the file (switches Orca's window to its worktree)"

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
  'account select',
  'account rm',
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

// Why: index.ts drops both selection flags for these commands without an error, so they always run here.
const UNUSED_REMOTE_SELECTION_HELP: Record<string, string> = {
  'pairing-code': '--pairing-code <code>  Not used; this command only runs on this machine',
  environment: '--environment <selector> Not used; this command only runs on this machine'
}

const REMOTE_SELECTION_IGNORING_COMMANDS = ['serve', 'vm recipe doctor', 'agent-context']

// Why: --environment names the managed server to act on here, and index.ts drops --pairing-code.
const MANAGED_SERVER_SELECTION_HELP: Record<string, string> = {
  'pairing-code': UNUSED_REMOTE_SELECTION_HELP['pairing-code'],
  environment: '--environment <selector> Managed Orca server to act on (see orca environment list)'
}

/** Per-command flag help, kept out of the shared help chain it would crowd. */
const COMMAND_SCOPED_FLAG_HELP: Record<string, Record<string, string>> = {
  ...Object.fromEntries(
    REMOTE_SELECTION_REJECTING_COMMANDS.map((command) => [command, REJECTED_REMOTE_SELECTION_HELP])
  ),
  ...Object.fromEntries(
    REMOTE_SELECTION_IGNORING_COMMANDS.map((command) => [command, UNUSED_REMOTE_SELECTION_HELP])
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
  'worktree create': {
    pr: '--pr <number>          Linked GitHub pull request number',
    'gitlab-issue': '--gitlab-issue <number|url> Linked GitLab issue in the source project',
    'gitlab-mr': '--gitlab-mr <number|url> Linked GitLab merge request in the source project'
  },
  'skills get': {
    full: '--full                 Print the full guide with bundled references',
    reference: '--reference <name>     Print one bundled reference by name',
    references: '--references           List the bundled reference names for a topic'
  },
  'environment status': MANAGED_SERVER_SELECTION_HELP,
  'environment update': {
    ...MANAGED_SERVER_SELECTION_HELP,
    force: '--force                Restart over running terminals instead of deferring the update'
  },
  'environment rollback': MANAGED_SERVER_SELECTION_HELP,
  'environment recover': {
    ...MANAGED_SERVER_SELECTION_HELP,
    'accept-changed-state':
      '--accept-changed-state Restore the prelaunch snapshot over state a rejected build changed',
    yes: '--yes                  Confirm discarding what the rejected build changed'
  },
  'environment stop': {
    ...MANAGED_SERVER_SELECTION_HELP,
    yes: '--yes                  Confirm stopping the server and unlinking it from this machine'
  },
  'environment cancel-stop': MANAGED_SERVER_SELECTION_HELP,
  'file open': {
    focus: FILE_OPEN_FOCUS_HELP
  },
  'file diff': {
    focus: FILE_OPEN_FOCUS_HELP
  },
  'file open-changed': {
    focus: FILE_OPEN_FOCUS_HELP
  },
  'skills install': {
    agent: '--agent <names>        Comma-separated install targets; default is detected agents'
  },
  'worktree set': {
    unread: '--unread               Mark the workspace unread in the sidebar',
    read: '--read                 Mark the workspace read, clearing the unread dot'
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
