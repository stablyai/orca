import { YOUTRACK_FLAG_HELP } from './youtrack-flag-help'

// Why: the shared --focus line describes terminal create's terminal session.
const FILE_OPEN_FOCUS_HELP =
  "--focus                Bring the user to the file (switches Orca's window to its worktree)"

/** Per-command flag help, kept out of the shared help chain it would crowd. */
const COMMAND_SCOPED_FLAG_HELP: Record<string, Record<string, string>> = {
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
  },
  ...YOUTRACK_FLAG_HELP
}

export function formatCommandScopedFlagHelp(command: string, flag: string): string | undefined {
  return COMMAND_SCOPED_FLAG_HELP[command]?.[flag]
}
