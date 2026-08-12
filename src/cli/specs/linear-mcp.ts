import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const LINEAR_MCP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['linear', 'save-issue'],
    summary: 'Create or update a Linear issue',
    usage:
      'orca linear save-issue [<id>] [--current] [--team <key|id>] [--title <title>] [--description <text> | --body-file <path|->] [--state <state>] [--assignee me|<user>|null] [--priority none|low|medium|high|urgent] [--estimate <number>|null] [--due-date <yyyy-mm-dd>|null] [--label <label>...] [--project <project>|null] [--parent-id <issue>|null] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'current',
      'team',
      'title',
      'description',
      'body',
      'body-file',
      'state',
      'assignee',
      'priority',
      'estimate',
      'due-date',
      'label',
      'project',
      'parent-id',
      'write-id',
      'workspace',
      'id'
    ],
    positionalArgs: ['id'],
    examples: [
      'orca linear save-issue --team ENG --title "Fix auth" --priority high --json',
      'orca linear save-issue ENG-123 --title "Fix OAuth callback" --assignee me --json',
      'orca linear save-issue --current --project null --due-date null --json'
    ],
    notes: [
      'Without <id> or --current, creates an issue and requires --team and --title.',
      'Labels replace the complete label set, matching Linear MCP save_issue semantics.',
      'Use the literal null to clear assignee, estimate, due date, project, or parent.'
    ]
  },
  {
    path: ['linear', 'list-issues'],
    summary: 'List Linear issues with MCP-compatible filters',
    usage:
      'orca linear list-issues [--team <team>] [--cycle <cycle>] [--label <label>] [--limit <n>] [--query <text>] [--state <state>] [--cursor <cursor>] [--order-by createdAt|updatedAt] [--project <project>] [--release <release>] [--assignee <user|me|null>] [--delegate <user|me|null>] [--parent-id <issue|null>] [--priority <0-4>] [--created-at <datetime|duration>] [--updated-at <datetime|duration>] [--include-archived] [--workspace <id>|all] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'team',
      'cycle',
      'label',
      'limit',
      'query',
      'state',
      'cursor',
      'order-by',
      'project',
      'release',
      'assignee',
      'delegate',
      'parent-id',
      'priority',
      'created-at',
      'updated-at',
      'include-archived',
      'workspace'
    ],
    examples: [
      'orca linear list-issues --team ENG --state started --assignee me --json',
      'orca linear list-issues --query auth --updated-at -P7D --limit 100 --json',
      'orca linear list-issues --cursor <cursor> --workspace <id> --json'
    ]
  },
  {
    path: ['linear', 'relation', 'add'],
    summary: 'Add a Linear issue relation',
    usage:
      'orca linear relation add [<id>] [--current] --related <issue> --type blocks|blocked-by|related|duplicate-of [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'related', 'type', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca linear relation add ENG-1 --related ENG-2 --type blocks --json',
      'orca linear relation add --current --related ENG-2 --type blocked-by --json'
    ]
  },
  {
    path: ['linear', 'relation', 'remove'],
    aliases: [['linear', 'relation', 'rm']],
    summary: 'Remove a Linear issue relation',
    usage:
      'orca linear relation remove [<id>] [--current] --related <issue> --type blocks|blocked-by|related|duplicate-of [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'related', 'type', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca linear relation remove ENG-1 --related ENG-2 --type related --json']
  }
]
