import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: Jira scopes every call to a connected site the way Linear scopes to a
// workspace, so `--site` is the shared optional selector across all commands.
const SITE_FLAGS = [...GLOBAL_FLAGS, 'site']

export const JIRA_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['jira', 'issue'],
    summary: 'Read a Jira issue',
    usage: 'orca jira issue <key> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca jira issue ENG-123', 'orca jira issue ENG-123 --json']
  },
  {
    path: ['jira', 'list'],
    summary: 'List Jira issues for task triage',
    usage:
      'orca jira list [--filter assigned|reported|all|done] [--limit <n>] [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'filter', 'limit'],
    examples: ['orca jira list --filter assigned --limit 10 --json']
  },
  {
    path: ['jira', 'search'],
    summary: 'Search Jira issues with JQL',
    usage: 'orca jira search <jql> [--limit <n>] [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'limit', 'jql'],
    positionalArgs: ['jql'],
    examples: [
      'orca jira search "project = ENG AND status = \'In Progress\'"',
      'orca jira search "assignee = currentUser() AND updated >= -1d" --json'
    ]
  },
  {
    path: ['jira', 'create'],
    summary: 'Create a Jira issue',
    usage:
      'orca jira create --project <idOrKey> --type <issueTypeId> --title <text> [--description <text>] [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'project', 'type', 'title', 'description'],
    examples: ['orca jira create --project ENG --type 10001 --title "Fix login redirect" --json']
  },
  {
    path: ['jira', 'project', 'list'],
    summary: 'List Jira projects',
    usage: 'orca jira project list [--site <id>] [--json]',
    allowedFlags: SITE_FLAGS,
    examples: ['orca jira project list --json']
  },
  {
    path: ['jira', 'project', 'types'],
    summary: 'List Jira issue types for a project',
    usage: 'orca jira project types --project <idOrKey> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'project'],
    examples: ['orca jira project types --project ENG --json']
  },
  {
    path: ['jira', 'comment', 'list'],
    summary: 'List comments on a Jira issue',
    usage: 'orca jira comment list <key> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca jira comment list ENG-123 --json']
  },
  {
    path: ['jira', 'comment', 'add'],
    summary: 'Comment on a Jira issue',
    usage: 'orca jira comment add <key> --body <text> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key', 'body'],
    positionalArgs: ['key'],
    examples: ['orca jira comment add ENG-123 --body "Fix is on staging"']
  },
  {
    path: ['jira', 'status', 'list'],
    summary: 'List available transitions for a Jira issue',
    usage: 'orca jira status list <key> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca jira status list ENG-123 --json']
  },
  {
    path: ['jira', 'status', 'set'],
    summary: 'Transition a Jira issue',
    usage:
      'orca jira status set <key> (--to <name> | --to-id <transitionId>) [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key', 'to', 'to-id'],
    positionalArgs: ['key'],
    examples: [
      'orca jira status set ENG-123 --to "In Review"',
      'orca jira status set ENG-123 --to-id 31 --json'
    ]
  },
  {
    path: ['jira', 'assignee', 'list'],
    summary: 'List assignable users for a Jira issue',
    usage: 'orca jira assignee list <key> [--query <text>] [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key', 'query'],
    positionalArgs: ['key'],
    examples: ['orca jira assignee list ENG-123 --query alex --json']
  },
  {
    path: ['jira', 'assignee', 'set'],
    summary: 'Assign a Jira issue',
    usage: 'orca jira assignee set <key> --to-id <accountId> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key', 'to-id'],
    positionalArgs: ['key'],
    examples: ['orca jira assignee set ENG-123 --to-id 5b10a2844c20165700ede21g --json']
  },
  {
    path: ['jira', 'assignee', 'clear'],
    summary: 'Clear a Jira issue assignee',
    usage: 'orca jira assignee clear <key> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca jira assignee clear ENG-123 --json']
  },
  {
    path: ['jira', 'priority', 'list'],
    summary: 'List Jira priorities',
    usage: 'orca jira priority list [--site <id>] [--json]',
    allowedFlags: SITE_FLAGS,
    examples: ['orca jira priority list --json']
  },
  {
    path: ['jira', 'priority', 'set'],
    summary: 'Set a Jira issue priority',
    usage: 'orca jira priority set <key> --to-id <priorityId> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key', 'to-id'],
    positionalArgs: ['key'],
    examples: ['orca jira priority set ENG-123 --to-id 2 --json']
  },
  {
    path: ['jira', 'priority', 'clear'],
    summary: 'Clear a Jira issue priority',
    usage: 'orca jira priority clear <key> [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca jira priority clear ENG-123 --json']
  },
  {
    path: ['jira', 'label', 'set'],
    summary: 'Replace the labels on a Jira issue',
    usage: 'orca jira label set <key> --label <name> [--label <name>...] [--site <id>] [--json]',
    allowedFlags: [...SITE_FLAGS, 'key', 'label'],
    positionalArgs: ['key'],
    examples: ['orca jira label set ENG-123 --label backend --label p1 --json']
  }
]
