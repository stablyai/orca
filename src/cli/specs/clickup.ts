import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const CLICKUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['clickup', 'task'],
    summary: 'Read a ClickUp task',
    usage: 'orca clickup task [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup task 86abc123 --json', 'orca clickup task --current --json']
  },
  {
    path: ['clickup', 'search'],
    summary: 'Search connected ClickUp Workspaces',
    usage: 'orca clickup search <query> [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit', 'workspace'],
    positionalArgs: ['query'],
    examples: ['orca clickup search "auth bug" --workspace all --json']
  },
  {
    path: ['clickup', 'list'],
    summary: 'List ClickUp tasks for triage',
    usage:
      'orca clickup list [--filter assigned|created|all|completed|open] [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'filter', 'limit', 'workspace'],
    examples: ['orca clickup list --filter assigned --limit 10 --json']
  },
  {
    path: ['clickup', 'workspace', 'list'],
    summary: 'List connected ClickUp Workspaces',
    usage: 'orca clickup workspace list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca clickup workspace list --json']
  },
  {
    path: ['clickup', 'destination', 'list'],
    summary: 'List ClickUp Lists available for task creation',
    usage: 'orca clickup destination list [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace'],
    examples: ['orca clickup destination list --workspace 12345 --json']
  },
  {
    path: ['clickup', 'status', 'set'],
    summary: 'Set a ClickUp task status',
    usage: 'orca clickup status set [<id>] [--current] --to <status> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup status set --current --to "in review" --json']
  },
  {
    path: ['clickup', 'priority', 'set'],
    summary: 'Set a ClickUp task priority',
    usage:
      'orca clickup priority set [<id>] [--current] --to urgent|high|normal|low [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup priority set 86abc123 --to high --json']
  },
  {
    path: ['clickup', 'priority', 'clear'],
    summary: 'Clear a ClickUp task priority',
    usage: 'orca clickup priority clear [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup priority clear --current --json']
  },
  {
    path: ['clickup', 'due-date', 'set'],
    summary: 'Set a ClickUp task due date',
    usage:
      'orca clickup due-date set [<id>] [--current] --to <yyyy-mm-dd> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup due-date set --current --to 2026-07-31 --json']
  },
  {
    path: ['clickup', 'due-date', 'clear'],
    summary: 'Clear a ClickUp task due date',
    usage: 'orca clickup due-date clear [<id>] [--current] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup due-date clear --current --json']
  },
  {
    path: ['clickup', 'comment', 'add'],
    summary: 'Add a comment to a ClickUp task',
    usage: 'orca clickup comment add [<id>] [--current] --body <text> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'body', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca clickup comment add --current --body "Ready for review." --json']
  },
  {
    path: ['clickup', 'create'],
    summary: 'Create a ClickUp task',
    usage:
      'orca clickup create --list <listId> --title <title> [--body <text>] [--status <status>] [--priority urgent|high|normal|low] [--due-date <yyyy-mm-dd>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'list',
      'title',
      'body',
      'status',
      'priority',
      'due-date',
      'workspace'
    ],
    examples: ['orca clickup create --list 90123 --title "Investigate flaky login" --json']
  }
]
