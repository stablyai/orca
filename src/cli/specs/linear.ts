import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const LINEAR_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['linear', 'issue'],
    summary: 'Read Linear issue context for agents',
    usage:
      'orca linear issue [<id>] [--current] [--comments] [--children] [--depth <n>] [--attachments] [--relations] [--full] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'current',
      'comments',
      'children',
      'depth',
      'attachments',
      'relations',
      'full',
      'workspace',
      'id'
    ],
    positionalArgs: ['id'],
    examples: [
      'orca linear issue ENG-123',
      'orca linear issue --current --comments',
      'orca linear issue https://linear.app/acme/issue/ENG-123 --full --json'
    ]
  },
  {
    path: ['linear', 'search'],
    summary: 'Search connected Linear workspaces',
    usage: 'orca linear search <query> [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'workspace', 'query'],
    positionalArgs: ['query'],
    examples: ['orca linear search "auth bug"', 'orca linear search ENG --workspace all --json']
  },
  {
    path: ['linear', 'status', 'set'],
    summary: 'Set a Linear issue status',
    usage: 'orca linear status set [<id>] [--current] --to <state> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'to', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca linear status set ENG-123 --to "In Review"',
      'orca linear status set --current --to Done --json'
    ]
  },
  {
    path: ['linear', 'comment', 'add'],
    summary: 'Add a comment to a Linear issue',
    usage:
      'orca linear comment add [<id>] [--current] (--body <text> | --body-file <path|->) [--reply-to <commentId>] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'current',
      'body',
      'body-file',
      'reply-to',
      'write-id',
      'workspace',
      'id'
    ],
    positionalArgs: ['id'],
    examples: [
      'orca linear comment add ENG-123 --body "Implementation is ready for review."',
      'orca linear comment add --current --body-file - --json'
    ],
    notes: ['Use --body-file - to read multiline comment bodies from stdin.']
  },
  {
    path: ['linear', 'attach'],
    summary: 'Attach a link to a Linear issue',
    usage:
      'orca linear attach [<id>] [--current] --url <url> [--title <title>] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'current', 'url', 'title', 'write-id', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca linear attach ENG-123 --url https://example.com/review/123 --title "PR/MR link"',
      'orca linear attach --current --url https://example.com/review/123 --json'
    ]
  },
  {
    path: ['linear', 'create'],
    summary: 'Create a Linear issue',
    usage:
      'orca linear create --title <title> [--body <text> | --body-file <path|->] [--team <key>] [--parent <id> | --parent-current] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'title',
      'body',
      'body-file',
      'team',
      'parent',
      'parent-current',
      'write-id',
      'workspace'
    ],
    examples: [
      'orca linear create --title "Investigate flaky login" --team ENG',
      'orca linear create --title "Follow-up bug" --parent-current --body-file - --json'
    ],
    notes: ['Use --body-file - to read multiline issue bodies from stdin.']
  }
]
