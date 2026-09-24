import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PLANE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plane', 'status'],
    summary: 'Check Plane connection status and active workspace',
    usage: 'orca plane status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca plane status', 'orca plane status --json']
  },
  {
    path: ['plane', 'connect'],
    summary: 'Connect to Plane via personal API token',
    usage:
      'orca plane connect --token <token> [--base-url <url>] [--auth-type cloud|self-hosted] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'token', 'base-url', 'auth-type'],
    examples: [
      'orca plane connect --token <api-token>',
      'orca plane connect --token <api-token> --base-url https://plane.mycompany.com --auth-type self-hosted --json'
    ]
  },
  {
    path: ['plane', 'disconnect'],
    summary: 'Disconnect from Plane',
    usage: 'orca plane disconnect [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca plane disconnect', 'orca plane disconnect --json']
  },
  {
    path: ['plane', 'workspace', 'list'],
    summary: 'List available Plane workspaces',
    usage: 'orca plane workspace list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca plane workspace list', 'orca plane workspace list --json']
  },
  {
    path: ['plane', 'workspace', 'select'],
    summary: 'Select active Plane workspace',
    usage: 'orca plane workspace select <slug> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'slug'],
    positionalArgs: ['slug'],
    examples: ['orca plane workspace select my-team', 'orca plane workspace select my-team --json']
  },
  {
    path: ['plane', 'project', 'list'],
    summary: 'List connected Plane projects',
    usage: 'orca plane project list [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace'],
    examples: ['orca plane project list', 'orca plane project list --workspace my-team --json']
  },
  {
    path: ['plane', 'state', 'list'],
    summary: 'List Plane workflow states for a project',
    usage: 'orca plane state list --project <projectId> [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'workspace'],
    examples: ['orca plane state list --project <projectId> --json']
  },
  {
    path: ['plane', 'list'],
    summary: 'List Plane issues for task triage',
    usage: 'orca plane list [--project <projectId>] [--limit <n>] [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'limit', 'workspace'],
    examples: ['orca plane list', 'orca plane list --project <projectId> --limit 10 --json']
  },
  {
    path: ['plane', 'issue'],
    summary: 'Read Plane issue details and comments',
    usage:
      'orca plane issue <id> [--project <projectId>] [--workspace <slug>] [--comments] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'workspace', 'comments', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca plane issue PROJ-123',
      'orca plane issue PROJ-123 --comments --json',
      'orca plane issue https://app.plane.so/my-team/projects/proj-id/issues/issue-id'
    ]
  },
  {
    path: ['plane', 'create'],
    summary: 'Create a Plane issue',
    usage:
      'orca plane create --title <title> --project <projectId> [--body <text> | --body-file <path|->] [--state <stateId>] [--priority none|low|medium|high|urgent] [--workspace <slug>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'title',
      'project',
      'body',
      'body-file',
      'state',
      'priority',
      'workspace'
    ],
    examples: [
      'orca plane create --title "Fix login glitch" --project <projectId>',
      'orca plane create --title "Crash report" --project <projectId> --priority urgent --json'
    ],
    notes: ['Use --body-file - to read multiline issue description from stdin.']
  },
  {
    path: ['plane', 'status', 'set'],
    summary: 'Set a Plane issue status/state',
    usage:
      'orca plane status set <id> --to <stateNameOrId> [--project <projectId>] [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'to', 'project', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca plane status set PROJ-123 --to "In Progress"',
      'orca plane status set PROJ-123 --to Done --json'
    ]
  },
  {
    path: ['plane', 'priority', 'set'],
    summary: 'Set a Plane issue priority',
    usage:
      'orca plane priority set <id> --to none|low|medium|high|urgent [--project <projectId>] [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'to', 'project', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca plane priority set PROJ-123 --to urgent --json']
  },
  {
    path: ['plane', 'priority', 'clear'],
    summary: 'Clear a Plane issue priority',
    usage: 'orca plane priority clear <id> [--project <projectId>] [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: ['orca plane priority clear PROJ-123 --json']
  },
  {
    path: ['plane', 'comment', 'add'],
    summary: 'Add a comment to a Plane issue',
    usage:
      'orca plane comment add <id> (--body <text> | --body-file <path|->) [--project <projectId>] [--workspace <slug>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'body', 'body-file', 'project', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca plane comment add PROJ-123 --body "PR is ready for review"',
      'orca plane comment add PROJ-123 --body-file - --json'
    ],
    notes: ['Use --body-file - to read multiline comment bodies from stdin.']
  }
]
