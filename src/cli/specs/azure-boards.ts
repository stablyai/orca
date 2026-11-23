import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const REPO_FLAGS = [...GLOBAL_FLAGS, 'repo']
const REPO_NOTE =
  'Reads the Azure DevOps project of --repo (id:<id>, name:<name> or path:<path>), or of the Orca workspace the command runs in.'

const WRITE_NOTE =
  'Without --confirm, prints the change and makes none; pass --confirm only after the user approved it. At most 20 comments and 20 updates a day go through Orca.'

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
  },
  {
    path: ['azure-boards', 'comment', 'add'],
    summary: 'Comment on a work item (needs --confirm)',
    usage:
      'orca azure-boards comment add <id> --body <text> [--confirm] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'body', 'confirm'],
    booleanFlags: ['confirm'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE, WRITE_NOTE]
  },
  {
    path: ['azure-boards', 'state', 'set'],
    summary: 'Move a work item to another state of its type (needs --confirm)',
    usage: 'orca azure-boards state set <id> --to <state> [--confirm] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'to', 'confirm'],
    booleanFlags: ['confirm'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE, WRITE_NOTE, 'An unknown state lists the valid ones for that item type.']
  },
  {
    path: ['azure-boards', 'assignee', 'set'],
    summary: 'Assign a work item (needs --confirm)',
    usage:
      'orca azure-boards assignee set <id> (--to <email> | --me) [--confirm] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'to', 'me', 'confirm'],
    booleanFlags: ['confirm', 'me'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE, WRITE_NOTE]
  },
  {
    path: ['azure-boards', 'assignee', 'clear'],
    summary: 'Unassign a work item (needs --confirm)',
    usage: 'orca azure-boards assignee clear <id> [--confirm] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'confirm'],
    booleanFlags: ['confirm'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE, WRITE_NOTE]
  }
]
