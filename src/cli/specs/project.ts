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
    usage: 'orca project setups [--project <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'host'],
    notes: [
      'A setup means a project is available on a server at a concrete filesystem path. Each row names the server that owns it; server=unknown means Orca cannot verify the owner from here.',
      'To list another server\u2019s setups, pass --server <id>.'
    ],
    examples: [
      'orca project setups',
      'orca project setups --project github:stablyai/orca',
      'orca project setups --server build-box'
    ]
  },
  {
    path: ['project', 'setup-existing-folder'],
    summary: 'Make a project available on a server by importing an existing folder',
    usage:
      'orca project setup-existing-folder --project <id> --path <path> [--kind git|folder] [--display-name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'host', 'path', 'kind', 'display-name'],
    notes: [
      'The folder is on the server the command runs on: this computer, or the one --server names. With --server, --path must be an absolute path on that server.',
      'SSH connections are set up through the desktop UI because the desktop client owns SSH connections.',
      "--project takes a project id or an existing project's name. A remote-backed Git folder's project id usually comes from its remote: github:owner/repo, github:<host>/owner/repo for GitHub Enterprise, or git:<host>/<path> for other remotes."
    ],
    examples: [
      'orca project setup-existing-folder --project github:stablyai/orca --path ~/orca',
      'orca project setup-existing-folder --project github:stablyai/orca --server build-box --path /home/me/orca --kind git --json'
    ]
  },
  {
    path: ['project', 'setup-clone'],
    summary: 'Make a project available on a server by cloning a repository',
    usage:
      'orca project setup-clone --project <id> --url <clone-url> --destination <path> [--folder-name <name>] [--display-name <name>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'project',
      'host',
      'url',
      'destination',
      'folder-name',
      'display-name'
    ],
    notes: [
      'The clone is made on the server the command runs on. With --server, --destination must be an absolute parent directory on that server.',
      '--folder-name sets the folder created inside --destination; it defaults to the repository name from the URL.',
      'SSH connections are cloned through the desktop UI because the desktop client owns SSH connections.'
    ],
    examples: [
      'orca project setup-clone --project github:stablyai/orca --url https://github.com/stablyai/orca.git --destination ~/src',
      'orca project setup-clone --project github:stablyai/orca --server build-box --url https://github.com/stablyai/orca.git --destination /srv --json'
    ]
  },
  {
    path: ['project', 'setup-create'],
    summary: 'Create independent project host setup metadata',
    usage:
      'orca project setup-create --project <id> [--setup-id <id>] [--path <path>] [--kind git|folder] [--display-name <name>] [--worktree-base-path <path>] [--git-username <name>] [--state ready|not-set-up|setting-up|error|unsupported] [--method imported-existing-folder|cloned|provisioned] [--json]',
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
      'The setup is recorded on the server the command runs on: this computer, or the one --server names.',
      'Use setup-existing-folder when Orca should import and manage an actual checkout path now.'
    ],
    examples: [
      'orca project setup-create --project github:stablyai/orca --server build-box --state setting-up --method provisioned --json'
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
      'host',
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
    usage: 'orca project setup-delete --setup <setup-id> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup', 'host', 'force'],
    notes: [
      'Independent setups are removed directly.',
      'Repo-backed setups remove the registered repo compatibility record.',
      'Refuses while the project has open terminals or saved workspace details; --force removes it anyway.'
    ],
    examples: ['orca project setup-delete --setup github:stablyai/orca::gpu --json']
  }
]
