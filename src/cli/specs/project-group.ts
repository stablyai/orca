import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const GROUP_SELECTOR_NOTE =
  '--group takes a group id or name from `orca project group list`; id:<id> and name:<name> force one kind. A name shared by several groups is refused.'

export const PROJECT_GROUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['project', 'group', 'list'],
    summary: 'List the project groups in the sidebar',
    usage: 'orca project group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      "A repo's group is the projectGroupId field in `orca repo show --json`; null means it is not in a group."
    ],
    examples: ['orca project group list --json']
  },
  {
    path: ['project', 'group', 'create'],
    summary: 'Create a project group in the sidebar',
    usage: 'orca project group create --name <name> [--parent-group <group>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'parent-group'],
    notes: [
      '--parent-group nests the new group inside an existing one; it takes a group id or name.',
      'Group names need not be unique. Prefer the returned id in later commands.'
    ],
    examples: [
      'orca project group create --name Clients --json',
      'orca project group create --name Archive --parent-group Clients --json'
    ]
  },
  {
    path: ['project', 'group', 'rename'],
    summary: 'Rename a project group',
    usage: 'orca project group rename --group <group> --name <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', 'name'],
    notes: [GROUP_SELECTOR_NOTE],
    examples: ['orca project group rename --group Clients --name Customers --json']
  },
  {
    path: ['project', 'group', 'move'],
    summary: 'Move a repo into a project group, or out of every group',
    usage:
      'orca project group move --repo <selector> (--group <group> | --no-group) [--order <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'group', 'no-group', 'order'],
    booleanFlags: ['no-group'],
    notes: [
      GROUP_SELECTOR_NOTE,
      '--no-group moves the repo back to the top level of the sidebar.',
      '--order sets its position among the projects in the target group; by default it goes last.',
      'Only the sidebar changes: terminals, agents and worktrees are not touched.'
    ],
    examples: [
      'orca project group move --repo name:acme-web --group Clients --json',
      'orca project group move --repo id:<repoId> --no-group --json'
    ]
  }
]
