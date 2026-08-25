import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const REPO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Orca',
    usage: 'orca repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Orca by filesystem path',
    usage: 'orca repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
  {
    path: ['repo', 'set'],
    summary: 'Update Orca settings for a repo',
    usage:
      'orca repo set --repo <selector> [--group <selector>|--ungroup] [--display-name <name>] [--badge-color <hex>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'group', 'ungroup', 'display-name', 'badge-color'],
    notes: [
      'Pass at least one update flag. --group moves the repo into a project group; --ungroup removes it from its group.',
      'Group selectors accept id:<groupId>, name:<name>, or a bare id/unique name.'
    ],
    examples: [
      'orca repo set --repo id:<repoId> --group name:Clients --json',
      'orca repo set --repo id:<repoId> --ungroup --json'
    ]
  },
  {
    path: ['repo', 'rm'],
    // Why: agents reach for git's `remove`/`delete` verbs; accept them as
    // aliases so a conventional guess resolves instead of dead-ending.
    aliases: [
      ['repo', 'remove'],
      ['repo', 'delete']
    ],
    destructive: true,
    summary: 'Remove a repo registration from Orca',
    usage: 'orca repo rm --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      'Only unregisters the repo from Orca — repo files and git worktree checkouts stay on disk.',
      'Orca worktree metadata for the repo (display names, comments, lineage, sparse presets) is dropped irreversibly.',
      'Use `orca worktree rm` first if the worktree checkouts themselves should be removed.'
    ]
  },
  {
    path: ['repo', 'group', 'list'],
    summary: 'List project groups',
    usage: 'orca repo group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'group', 'create'],
    summary: 'Create a project group',
    usage: 'orca repo group create --name <name> [--parent-group <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'parent-group'],
    notes: [
      'Group names are not required to be unique; selectors fall back to id:<groupId> when a name is ambiguous.',
      'Move repos into the new group with `orca repo set --repo <selector> --group <selector>`.'
    ]
  },
  {
    path: ['repo', 'group', 'set'],
    summary: 'Update a project group',
    usage: 'orca repo group set --group <selector> [--name <name>] [--color <hex|null>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group', 'name', 'color'],
    notes: ['Pass at least one update flag. Pass --color null to clear the group color.']
  },
  {
    path: ['repo', 'group', 'rm'],
    aliases: [
      ['repo', 'group', 'remove'],
      ['repo', 'group', 'delete']
    ],
    destructive: true,
    summary: 'Delete a project group',
    usage: 'orca repo group rm --group <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group'],
    notes: [
      'Deletes the group and all nested subgroups. Repos in deleted groups are kept and become ungrouped.',
      'Folder workspaces belonging to deleted groups are removed.'
    ]
  }
]
