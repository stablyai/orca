import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

const TARGET_NOTE =
  'When --worktree is omitted, local CLI calls use the Orca workspace that contains the current directory. Folder workspaces (folder:<id>) are supported.'
const FILE_NOTE =
  '--file is relative to the workspace root, or an absolute path inside it, as in orca file open.'

export const WORKTREE_NOTES_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['worktree', 'notes', 'list'],
    summary: 'List review notes left on lines of a workspace',
    usage: 'orca worktree notes list [--file <path>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file', 'worktree'],
    notes: [TARGET_NOTE, FILE_NOTE],
    examples: ['orca worktree notes list', 'orca worktree notes list --file src/App.tsx --json']
  },
  {
    path: ['worktree', 'notes', 'add'],
    summary: 'Leave a review note on a line or line range of a file',
    usage:
      'orca worktree notes add --file <path> --line <n> [--start-line <n>] (--body <text> | --body-file <path|->) [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file', 'line', 'start-line', 'body', 'body-file', 'worktree'],
    notes: [
      TARGET_NOTE,
      FILE_NOTE,
      '--line is the last line of the note, 1-based, on the current version of the file. --start-line makes it a range and must not be after --line.',
      'The note appears in the diff and with the other review notes, and can be sent to an agent like a note written in Orca. Existing notes are kept.',
      'Prints the new note id; pass it to orca worktree notes clear --id to remove the note.'
    ],
    examples: [
      'orca worktree notes add --file src/App.tsx --line 42 --body "This can be null after logout"',
      'orca worktree notes add --file src/App.tsx --start-line 40 --line 48 --body-file - --json < finding.md'
    ]
  },
  {
    path: ['worktree', 'notes', 'clear'],
    destructive: true,
    summary: 'Delete review notes by id, by file, or all of them',
    usage:
      'orca worktree notes clear (--id <id> | --file <path> | --all) [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'file', 'all', 'worktree'],
    repeatableFlags: ['id'],
    notes: [
      TARGET_NOTE,
      'Pass one of --id (repeat for several), --file or --all. Notes added elsewhere since the command read the list are kept.'
    ],
    examples: [
      'orca worktree notes clear --id 3f9c1a52-7e0b-4d6a-9a41-0c2f8e5b6d17',
      'orca worktree notes clear --file src/App.tsx --json',
      'orca worktree notes clear --all'
    ]
  }
]
