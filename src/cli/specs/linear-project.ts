import { LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES } from '../../shared/linear/project-agent-writes'
import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const PROJECT_TARGET_NOTE =
  '<project> accepts a project UUID, slugId, Linear project URL, or unique exact name.'
const PROJECT_METADATA_NOTE =
  'Project statuses and project labels are workspace entities distinct from issue workflow states and issue labels.'

export const LINEAR_PROJECT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['linear', 'project', 'show'],
    summary: 'Show one Linear project',
    usage:
      'orca linear project show (<project> | --id <project>) [--updates] [--updates-limit <n>] [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'updates', 'updates-limit', 'workspace', 'id'],
    positionalArgs: ['id'],
    examples: [
      'orca linear project show launch-q3',
      'orca linear project show --id https://linear.app/acme/project/launch-q3-1a2b3c --json',
      'orca linear project show launch-q3 --updates --updates-limit 10 --json'
    ],
    notes: [
      PROJECT_TARGET_NOTE,
      '--updates-limit requires --updates and is capped at 25.',
      '--workspace all is not valid for a single project read.'
    ]
  },
  {
    path: ['linear', 'project', 'statuses'],
    summary: 'List Linear project statuses',
    usage:
      'orca linear project statuses [--query <text>] [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit', 'workspace'],
    examples: [
      'orca linear project statuses --workspace workspace-1 --json',
      'orca linear project statuses --query progress --limit 10 --json'
    ],
    notes: [PROJECT_METADATA_NOTE]
  },
  {
    path: ['linear', 'project', 'labels'],
    summary: 'List Linear project labels',
    usage:
      'orca linear project labels [--query <text>] [--limit <n>] [--workspace <id>|all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit', 'workspace'],
    examples: [
      'orca linear project labels --workspace workspace-1 --json',
      'orca linear project labels --query launch --limit 20 --json'
    ],
    notes: [PROJECT_METADATA_NOTE]
  },
  {
    path: ['linear', 'project', 'create'],
    summary: 'Create a Linear project',
    usage:
      'orca linear project create --name <title> --team <team>... [--description <text>] [--content <text> | --content-file <path|->] [--status <status>] [--lead me|<user>] [--member <user>...] [--label <label>...] [--priority none|low|medium|high|urgent] [--start-date <yyyy-mm-dd>] [--target-date <yyyy-mm-dd>] [--color <#RRGGBB>] [--write-id <uuid-v4>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'team',
      'description',
      'content',
      'content-file',
      'status',
      'lead',
      'member',
      'label',
      'priority',
      'start-date',
      'target-date',
      'color',
      'write-id',
      'workspace'
    ],
    repeatableFlags: ['team', 'member', 'label'],
    examples: [
      'orca linear project create --name "Payments V2" --team ENG --description "Card + ACH rails"',
      'orca linear project create --name "Payments V2" --team ENG --team DESIGN --content-file - --json'
    ],
    notes: [
      '--name and at least one --team are required; there is no positional project argument.',
      'Repeat --team, --member, and --label to pass more than one value.',
      'All teams must resolve inside one workspace; --status and --label are project statuses and project labels, not issue workflow states or issue labels.',
      'Use --content-file - to read the long Markdown overview from stdin; over SSH only - is accepted.',
      '--color needs shell quoting because # starts a shell comment.',
      '--write-id must be a UUID v4 and pins the created project id so a retry cannot create a second project.',
      '--workspace all is not valid for a project write.'
    ]
  },
  {
    path: ['linear', 'project', 'edit'],
    summary: 'Edit Linear project fields',
    usage:
      'orca linear project edit (<project> | --id <project>) [--name <title>] [--description <text> | --clear-description] [--content <text> | --content-file <path|-> | --clear-content] [--status <status>] [--lead me|<user> | --clear-lead] [--member <user>... | --clear-members] [--team <team>...] [--label <label>... | --clear-labels] [--priority none|low|medium|high|urgent] [--start-date <yyyy-mm-dd> | --clear-start-date] [--target-date <yyyy-mm-dd> | --clear-target-date] [--color <#RRGGBB>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'description',
      'clear-description',
      'content',
      'content-file',
      'clear-content',
      'status',
      'lead',
      'clear-lead',
      'member',
      'clear-members',
      'team',
      'label',
      'clear-labels',
      'priority',
      'start-date',
      'clear-start-date',
      'target-date',
      'clear-target-date',
      'color',
      'workspace',
      'id'
    ],
    repeatableFlags: ['team', 'member', 'label'],
    positionalArgs: ['id'],
    examples: [
      'orca linear project edit launch-q3 --status "In Progress" --target-date 2026-10-01',
      'orca linear project edit launch-q3 --member ada --member grace --clear-labels',
      'orca linear project edit --id launch-q3 --content-file - --clear-lead --json'
    ],
    notes: [
      PROJECT_TARGET_NOTE,
      'At least one field flag or --clear-* flag is required; each --clear-* flag is exclusive with its value flag.',
      'Repeated --member, --team, and --label REPLACE the whole collection; they never append.',
      'Use --clear-members or --clear-labels to empty a collection; --team always needs at least one team, and status and color have no clear form.',
      '--clear-content empties the overview to blank text; Linear cannot restore it to unset once a project has had content.',
      'Only requested fields change; when they all already match, the edit is a no-op and no write is sent.',
      'There is no --write-id: Linear cannot dedup a project field edit, so every edit is verified by reading the fields back.',
      'Linear reformats --content Markdown as it stores it (it autolinks bare URLs and strips trailing whitespace), so the stored text in `current` can differ from what was sent; the edit still counts as applied.',
      'Use --content-file - to read the long Markdown overview from stdin; over SSH only - is accepted.',
      '--color needs shell quoting because # starts a shell comment.',
      'Re-run `orca linear project show <project> --json` to confirm the result of an unconfirmed edit.',
      '--workspace all is not valid for a project write.'
    ]
  },
  {
    path: ['linear', 'project', 'update', 'add'],
    summary: 'Post a Linear project update',
    usage:
      'orca linear project update add (<project> | --id <project>) (--body <text> | --body-file <path|->) [--health on-track|at-risk|off-track] [--hide-diff] [--write-id <uuid>] [--workspace <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'body',
      'body-file',
      'health',
      'hide-diff',
      'write-id',
      'workspace',
      'id'
    ],
    positionalArgs: ['id'],
    examples: [
      'orca linear project update add launch-q3 --body "Rails migration merged; load test pending." --health at-risk',
      'orca linear project update add --id launch-q3 --body-file - --hide-diff --json'
    ],
    notes: [
      PROJECT_TARGET_NOTE,
      'Use --body-file - to read a multiline update body from stdin; over SSH only - is accepted.',
      `--health accepts only ${LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES.join(', ')}.`,
      'This appends a new project update; it never edits project fields.',
      '--workspace all is not valid for a project write.'
    ]
  }
]
