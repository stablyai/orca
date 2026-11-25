import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const GROUP_SELECTOR_NOTE =
  'A group is named by id:<id>, name:<name>, or a bare id or name; a name shared by several groups needs the id.'

export const GROUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['group', 'list'],
    summary: 'List the project groups of the sidebar',
    usage: 'orca group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Each group has an id, name, parentGroupId (null at the top level), tabOrder, rootProjectOrder when the top level is ranked, and color.',
      "A repo's group is its projectGroupId in `orca repo list --json`."
    ]
  },
  {
    path: ['group', 'create'],
    summary: 'Create a project group, optionally nested in another',
    usage: 'orca group create --name <name> [--parent <group>] [--color <hex>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'parent', 'color'],
    notes: [GROUP_SELECTOR_NOTE, 'The new group goes last among its siblings.'],
    examples: [
      'orca group create --name Clients --json',
      'orca group create --name Acme --parent name:Clients --color "#22c55e" --json'
    ]
  },
  {
    path: ['group', 'set'],
    summary: 'Rename, recolor, re-parent or reorder a project group',
    usage:
      'orca group set --group <group> [--name <name>] [--parent <group>|none] [--color <hex>|none] [--order <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', 'name', 'parent', 'color', 'order'],
    notes: [
      GROUP_SELECTOR_NOTE,
      '--parent none moves the group to the top level, after the rows already there. A group cannot move into itself or a group nested inside it.',
      '--order is the sort position among sibling groups, lowest first. At the top level, groups and ungrouped projects share one ranking once the sidebar has one; --order then sets rootProjectOrder, and otherwise tabOrder.',
      '--parent needs an Orca host that has projectGroup.setParent; an older host refuses and changes nothing.'
    ],
    examples: [
      'orca group set --group name:Acme --name "Acme Corp" --color none --json',
      'orca group set --group id:<groupId> --parent name:Clients --order 0 --json'
    ]
  },
  {
    path: ['group', 'rm'],
    summary: 'Remove a project group',
    usage: 'orca group rm --group <group> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', 'force'],
    destructive: true,
    notes: [
      GROUP_SELECTOR_NOTE,
      'Refuses a group that still holds projects, nested groups or folder workspaces unless --force is passed.',
      'With --force its projects stay in Orca and move to no group, and its nested groups and folder workspaces are removed from Orca. No files on disk are deleted.'
    ],
    examples: ['orca group rm --group name:Acme --json']
  }
]
