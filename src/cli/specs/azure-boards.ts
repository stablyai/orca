import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const REPO_FLAGS = [...GLOBAL_FLAGS, 'repo']
const REPO_NOTE =
  'Reads the Azure DevOps project of --repo (id:<id>, name:<name> or path:<path>), or of the Orca workspace the command runs in.'

export const AZURE_BOARDS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['azure-boards', 'connection'],
    summary: 'Show who Orca reads Azure Boards as, for a repo',
    usage: 'orca azure-boards connection [--repo <selector>] [--json]',
    allowedFlags: REPO_FLAGS,
    notes: [REPO_NOTE, 'Never prints a credential.']
  },
  {
    path: ['azure-boards', 'item'],
    summary: 'Read an Azure Boards work item',
    usage: 'orca azure-boards item <id> [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE],
    examples: ['orca azure-boards item 1234', 'orca azure-boards item 1234 --json']
  },
  {
    path: ['azure-boards', 'comment', 'list'],
    summary: "List a work item's comments, newest first",
    usage: 'orca azure-boards comment list <id> [--limit <n>] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'limit'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE]
  },
  {
    path: ['azure-boards', 'search'],
    summary: 'Search work items with WIQL',
    usage: 'orca azure-boards search <wiql> [--limit <n>] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'wiql', 'limit'],
    positionalArgs: ['wiql'],
    notes: [
      REPO_NOTE,
      'The query runs as written; scope it with [System.TeamProject] = @project. --limit defaults to 50, at most 200.'
    ],
    examples: [
      'orca azure-boards search "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] = \'Active\'"',
      'orca azure-boards search "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] >= @Today - 7" --json'
    ]
  },
  {
    path: ['azure-boards', 'assigned'],
    summary: "List the project's work items assigned to you",
    usage: 'orca azure-boards assigned [--repo <selector>] [--json]',
    allowedFlags: REPO_FLAGS,
    notes: [REPO_NOTE]
  },
  {
    path: ['azure-boards', 'team', 'list'],
    summary: "List the project's teams",
    usage: 'orca azure-boards team list [--repo <selector>] [--json]',
    allowedFlags: REPO_FLAGS,
    notes: [REPO_NOTE]
  }
]
