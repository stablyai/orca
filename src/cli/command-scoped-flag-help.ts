// File focus differs from terminal create's shared --focus help.
const FILE_OPEN_FOCUS_HELP =
  "--focus                Bring the user to the file (switches Orca's window to its worktree)"

const COMMAND_SCOPED_FLAG_HELP: Record<string, Record<string, string>> = {
  'reference add': {
    url: '--url <url-or-jira-key> Full review/issue URL or Jira key; use positionals or repeated --url',
    'reference-site': '--reference-site <id> Jira site for bare keys; see orca jira connection'
  },
  'reference remove': {
    url: '--url <url>            Full review or issue URL; pass all URLs positionally or all as repeated --url',
    key: '--key <key>            Opaque key from reference list; repeat for several'
  },
  'computer get-app-state': {
    query:
      '--query <text>        Show only elements whose line contains this text, with their ancestors'
  },
  'reference find': {
    query: '--query <url-or-key>   Full URL or native issue key such as STA-1234',
    repo: '--repo <selector>      Filter by workspace repository membership',
    'include-archived': '--include-archived     Include archived workspaces',
    limit: '--limit <n>            Maximum matching workspaces (default 50)'
  },
  'worktree create': {
    branch: '--branch <name>        Git branch name to use instead of the prefixed default',
    reference:
      '--reference <url-or-jira-key> Attach an issue/review URL or Jira key; repeat for several',
    'reference-site': '--reference-site <id> Jira site for bare keys; see orca jira connection',
    pr: '--pr <number>          Linked GitHub pull request number',
    'gitlab-issue': '--gitlab-issue <number|url> Linked GitLab issue in the source project',
    'gitlab-mr': '--gitlab-mr <number|url> Linked GitLab merge request in the source project'
  },
  'skills get': {
    full: '--full                 Print the full guide with bundled references',
    reference: '--reference <name>     Print one bundled reference by name',
    references: '--references           List the bundled reference names for a topic'
  },
  'environment update': {
    force: '--force                Restart over running terminals instead of deferring the update'
  },
  'environment recover': {
    'accept-changed-state':
      '--accept-changed-state Restore the prelaunch snapshot over state a rejected build changed',
    yes: '--yes                  Confirm discarding what the rejected build changed'
  },
  'environment stop': {
    yes: '--yes                  Confirm stopping the server and unlinking it from this machine'
  },
  'file open': {
    line: '--line <n>             Cursor line (1-based)',
    column: '--column <n>           Cursor column (1-based; requires --line)',
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
  'orchestration run-show': {
    removed: '--removed              List the Tasks, Dispatches and workers removed from this Run',
    cursor: '--cursor <cursor>      Cursor printed by the previous page of removed work'
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
  ports: {
    all: '--all                  List every listener on the workspace host, not just this workspace'
  },
  snapshot: {
    interactive:
      '--interactive          Only interactive elements (buttons, inputs, links); no page text',
    compact: '--compact              Drop empty structural nodes',
    depth: '--depth <n>            Limit the tree to n levels',
    selector: '--selector <css>       Snapshot only the element matching this CSS selector',
    urls: '--urls                 Include link URLs',
    delta: '--delta                Return only what changed since the last --delta snapshot',
    full: '--full                 Return the whole tree and reset the --delta baseline'
  },
  screenshot: {
    'if-changed':
      '--if-changed           Skip saving when the page looks the same as the last capture',
    annotate: '--annotate             Label interactive elements; label [N] is ref @eN'
  },
  exec: {
    command: '--command <text>       agent-browser command and arguments, e.g. "get text @e3"'
  },
  wait: {
    selector: '--selector <sel>       Wait for an element by ref or CSS selector',
    timeout: '--timeout <ms>         How long to wait for the condition, or a plain pause',
    text: '--text <text>          Wait until this text appears on the page',
    url: '--url <pattern>        Wait until the page URL contains this text or matches a glob',
    load: '--load <state>         Wait for load or domcontentloaded (networkidle only on quiet pages)',
    fn: '--fn <js>              Wait until this JavaScript expression is truthy',
    state: '--state <state>        With --selector, wait for hidden or visible'
  },
  download: {
    selector: '--selector <ref>       Element ref or CSS selector of the download link',
    path: '--path <path>          File path to save the download to'
  }
}

export function formatCommandScopedFlagHelp(command: string, flag: string): string | undefined {
  return COMMAND_SCOPED_FLAG_HELP[command]?.[flag]
}
