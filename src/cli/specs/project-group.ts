import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const GROUP_SELECTOR_NOTE =
  '--group takes a group id or name; names match case-insensitively and an ambiguous name is refused.'
const PROJECT_TARGET_FLAGS = ['repo', 'project', 'host', 'project-host-setup']
const PROJECT_TARGET_NOTE =
  'Pick the project like `orca worktree create`: --project <id-or-name> (add --host when it is set up on several hosts), --project-host-setup <id>, or --repo <selector>.'

export const PROJECT_GROUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['project', 'group', 'list'],
    summary: 'List project groups and the projects in each',
    usage: 'orca project group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca project group list', 'orca project group list --json']
  },
  {
    path: ['project', 'group', 'create'],
    summary: 'Create a project group',
    usage: 'orca project group create --name <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca project group create --name Archive --json']
  },
  {
    path: ['project', 'group', 'rename'],
    summary: 'Rename a project group',
    usage: 'orca project group rename --group <id-or-name> --name <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', 'name'],
    notes: [GROUP_SELECTOR_NOTE],
    examples: ['orca project group rename --group Archive --name "Archived projects"']
  },
  {
    path: ['project', 'group', 'rm'],
    destructive: true,
    summary: 'Delete a project group without removing its projects',
    usage: 'orca project group rm --group <id-or-name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group'],
    notes: [
      GROUP_SELECTOR_NOTE,
      'Projects in the group and its child groups become ungrouped; no project, repo or file is removed.',
      "Child groups and the group's folder workspace entries are removed from Orca; their folders stay on disk."
    ],
    examples: ['orca project group rm --group Archive --json']
  },
  {
    path: ['project', 'group', 'add'],
    summary: 'Move a project into a project group',
    usage:
      'orca project group add --group <id-or-name> (--project <id-or-name> [--host <host>] | --project-host-setup <id> | --repo <selector>) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', ...PROJECT_TARGET_FLAGS],
    notes: [GROUP_SELECTOR_NOTE, PROJECT_TARGET_NOTE, 'A project already in a group is moved.'],
    examples: [
      'orca project group add --group Archive --project github:stablyai/orca',
      'orca project group add --group Archive --repo path:/Users/me/src/old-tool --json'
    ]
  },
  {
    path: ['project', 'group', 'ungroup'],
    summary: 'Take a project out of its project group',
    usage:
      'orca project group ungroup (--project <id-or-name> [--host <host>] | --project-host-setup <id> | --repo <selector>) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...PROJECT_TARGET_FLAGS],
    notes: [PROJECT_TARGET_NOTE],
    examples: ['orca project group ungroup --project github:stablyai/orca']
  }
]
