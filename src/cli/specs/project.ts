import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PROJECT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['project', 'list'],
    summary: 'List durable projects known to Orca',
    usage: 'orca project list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca project list', 'orca project list --json']
  },
  {
    path: ['project', 'setups'],
    summary: 'List project host setups',
    usage: 'orca project setups [--project <id>] [--host <host-id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'host'],
    notes: ['A setup means a project is available on a host at a concrete filesystem path.'],
    examples: [
      'orca project setups',
      'orca project setups --project github:stablyai/orca',
      'orca project setups --host local'
    ]
  },
  {
    path: ['project', 'setup-existing-folder'],
    summary: 'Make a project available on a host by importing an existing folder',
    usage:
      'orca project setup-existing-folder --project <id> --host <host-id> --path <path> [--kind git|folder] [--display-name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'host', 'path', 'kind', 'display-name'],
    notes: [
      'For remote runtimes, --path must be an absolute path on the remote server.',
      'SSH targets are set up through the desktop UI because the desktop client owns SSH connections.'
    ],
    examples: [
      'orca project setup-existing-folder --project github:stablyai/orca --host local --path ~/orca',
      'orca project setup-existing-folder --project github:stablyai/orca --host runtime:gpu --path /home/me/orca --kind git --json'
    ]
  },
  {
    path: ['project', 'setup-clone'],
    summary: 'Make a project available on a host by cloning a repository',
    usage:
      'orca project setup-clone --project <id> --host <host-id> --url <clone-url> --destination <path> [--display-name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'host', 'url', 'destination', 'display-name'],
    notes: [
      'For remote runtimes, --destination must be an absolute parent directory on the remote server.',
      'SSH targets are cloned through the desktop UI because the desktop client owns SSH connections.'
    ],
    examples: [
      'orca project setup-clone --project github:stablyai/orca --host local --url https://github.com/stablyai/orca.git --destination ~/src',
      'orca project setup-clone --project github:stablyai/orca --host runtime:gpu --url https://github.com/stablyai/orca.git --destination /srv --json'
    ]
  },
  {
    path: ['project', 'setup-create'],
    summary: 'Create independent project host setup metadata',
    usage:
      'orca project setup-create --project <id> --host <host-id> [--setup-id <id>] [--path <path>] [--kind git|folder] [--display-name <name>] [--worktree-base-path <path>] [--git-username <name>] [--state ready|not-set-up|setting-up|error|unsupported] [--method imported-existing-folder|cloned|provisioned] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'project',
      'host',
      'setup-id',
      'path',
      'kind',
      'display-name',
      'worktree-base-path',
      'git-username',
      'state',
      'method'
    ],
    notes: [
      'Creates setup metadata without registering a repo compatibility record.',
      'Use setup-existing-folder when Orca should import and manage an actual checkout path now.'
    ],
    examples: [
      'orca project setup-create --project github:stablyai/orca --host runtime:gpu --state setting-up --method provisioned --json'
    ]
  },
  {
    path: ['project', 'setup-update'],
    summary: 'Update project host setup metadata',
    usage:
      'orca project setup-update --setup <setup-id> [--display-name <name>] [--path <path>] [--worktree-base-path <path>] [--git-username <name>] [--kind git|folder] [--state ready|not-set-up|setting-up|error|unsupported] [--method legacy-repo|imported-existing-folder|cloned|provisioned] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'setup',
      'display-name',
      'path',
      'worktree-base-path',
      'git-username',
      'kind',
      'state',
      'method'
    ],
    notes: [
      'Repo-backed setups mirror safe fields onto the repo record.',
      'Path and availability state changes are only supported for independent setup records.'
    ],
    examples: [
      'orca project setup-update --setup github:stablyai/orca::gpu --display-name "GPU VM"',
      'orca project setup-update --setup github:stablyai/orca::gpu --path /srv/orca --state ready --json'
    ]
  },
  {
    path: ['project', 'setup-delete'],
    destructive: true,
    summary: 'Remove a project host setup',
    usage: 'orca project setup-delete --setup <setup-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup'],
    notes: [
      'Independent setups are removed directly.',
      'Repo-backed setups remove the registered repo compatibility record.'
    ],
    examples: ['orca project setup-delete --setup github:stablyai/orca::gpu --json']
  },
  {
    path: ['project', 'group', 'create'],
    summary: 'Create a project group for organizing the sidebar',
    usage: 'orca project group create <name> [--parent-path <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'parent-path'],
    positionalArgs: ['name'],
    notes: [
      'Groups let headless workflows organize an otherwise flat project list (e.g. an umbrella repo plus its child repos).'
    ],
    examples: ['orca project group create frontend', 'orca project group create frontend --json']
  },
  {
    path: ['project', 'group', 'list'],
    summary: 'List project groups',
    usage: 'orca project group list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca project group list', 'orca project group list --json']
  },
  {
    path: ['project', 'group', 'add'],
    summary: 'Add a project to a project group',
    usage:
      'orca project group add (--project <id> [--host <host-id>] | --project-host-setup <id> | --repo <selector>) --group <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'host', 'project-host-setup', 'repo', 'group'],
    notes: [
      'Select the project the same way as `orca worktree create`: --project (with --host to disambiguate a project set up on several hosts), --project-host-setup, or a direct --repo selector.',
      'Choose either --repo or the project target flags, not both.'
    ],
    examples: [
      'orca project group add --project github:stablyai/orca --group 1f3c...',
      'orca project group add --project github:stablyai/orca --host local --group 1f3c... --json',
      'orca project group add --repo id:9a2b... --group 1f3c...'
    ]
  },
  {
    path: ['project', 'group', 'rm'],
    summary: 'Delete a project group',
    usage: 'orca project group rm --group <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'group'],
    destructive: true,
    notes: ['Repos in the group are ungrouped, not deleted.'],
    examples: [
      'orca project group rm --group 1f3c...',
      'orca project group rm --group 1f3c... --json'
    ]
  }
]
