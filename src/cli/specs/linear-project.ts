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
