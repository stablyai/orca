import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PROJECT_GROUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['project-group', 'scan-nested'],
    summary: 'Scan a folder for nested Git repositories',
    usage: 'orca project-group scan-nested --path <folder> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path'],
    notes: [
      'This command only discovers repositories; it does not modify Orca.',
      'For remote runtimes, --path must be absolute on the remote server.'
    ],
    examples: [
      'orca project-group scan-nested --path ./workspace',
      'orca project-group scan-nested --path /srv/workspace --environment build-server --json'
    ]
  },
  {
    path: ['project-group', 'import-nested'],
    summary: 'Import selected nested repositories into Orca',
    usage:
      'orca project-group import-nested --path <folder> --project-path <repo> [--project-path <repo>...] --mode group|separate [--group-name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'project-path', 'mode', 'group-name'],
    notes: [
      'Repeat --project-path for each repository selected from scan-nested.',
      'Group mode creates a new folder-backed project group; it does not append to an existing group.',
      'Separate mode registers each repository independently.',
      'For remote runtimes, --path and every --project-path must be absolute on the remote server.'
    ],
    examples: [
      'orca project-group import-nested --path ./workspace --project-path ./workspace/api --project-path ./workspace/web --mode group --group-name workspace',
      'orca project-group import-nested --path /srv/workspace --project-path /srv/workspace/api --mode separate --environment build-server --json'
    ]
  }
]
