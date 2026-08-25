import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PLANE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plane', 'status'],
    summary: 'Show Plane connection status',
    usage: 'orca plane status [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['plane', 'connect'],
    summary: 'Connect a Plane instance',
    usage: 'orca plane connect --base-url <url> --workspace <slug> --api-key <pat> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'base-url', 'workspace', 'api-key']
  },
  {
    path: ['plane', 'project', 'list'],
    summary: 'List Plane projects',
    usage: 'orca plane project list [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'instance']
  },
  {
    path: ['plane', 'cycle', 'list'],
    summary: 'List Plane cycles for a project',
    usage: 'orca plane cycle list --project <project-id> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'instance']
  },
  {
    path: ['plane', 'module', 'list'],
    summary: 'List Plane modules for a project',
    usage: 'orca plane module list --project <project-id> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'instance']
  },
  {
    path: ['plane', 'type', 'list'],
    summary: 'List Plane work item types for a project',
    usage: 'orca plane type list --project <project-id> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'instance']
  },
  {
    path: ['plane', 'estimate', 'list'],
    summary: 'List Plane estimates for a project',
    usage: 'orca plane estimate list --project <project-id> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'instance']
  },
  {
    path: ['plane', 'issue'],
    summary: 'Read Plane work item context',
    usage: 'orca plane issue <id|AIF-123|url> [--instance <id>] [--comments] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'instance', 'comments', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'search'],
    summary: 'Search Plane work items',
    usage: 'orca plane search <query> [--limit <n>] [--instance <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit', 'instance'],
    positionalArgs: ['query']
  },
  {
    path: ['plane', 'list'],
    summary: 'List Plane work items',
    usage: 'orca plane list [--filter assigned|created|all|open|completed] [--limit <n>] [--instance <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'filter', 'limit', 'instance']
  },
  {
    path: ['plane', 'status', 'set'],
    summary: 'Set a Plane work item state',
    usage: 'orca plane status set <id|AIF-123> --to <state-id> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'to', 'instance', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'delete'],
    summary: 'Delete a Plane work item',
    usage: 'orca plane delete <id|AIF-123> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'instance', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'comment', 'add'],
    summary: 'Add a comment to a Plane work item',
    usage: 'orca plane comment add <id|AIF-123> --body <text> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'body', 'instance', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'link', 'list'],
    summary: 'List Plane work item links',
    usage: 'orca plane link list <id|AIF-123> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'instance', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'link', 'add'],
    summary: 'Add a link to a Plane work item',
    usage: 'orca plane link add <id|AIF-123> --title <text> --url <url> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'title', 'url', 'instance', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'attachment', 'list'],
    summary: 'List Plane work item attachment metadata',
    usage: 'orca plane attachment list <id|AIF-123> [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'instance', 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['plane', 'create'],
    summary: 'Create a Plane work item',
    usage: 'orca plane create --project <project-id> --title <title> [--body <text>] [--state <state-id>] [--priority <priority>] [--cycle <cycle-id>] [--module <module-id>] [--type <type-id>] [--estimate <estimate-point-id>] [--external-source <name>] [--external-id <id>] [--instance <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'title', 'body', 'state', 'priority', 'cycle', 'module', 'type', 'estimate', 'external-source', 'external-id', 'instance']
  }
]
