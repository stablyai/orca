import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const DIFF_NOTE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['diff-note', 'create'],
    summary: 'Pin an agent-authored note to a diff line',
    usage:
      'orca diff-note create <path> --line <n> --body <text> [--rationale <text>] [--author <name>] [--start-line <n>] [--scope unstaged|staged|branch] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'path',
      'line',
      'body',
      'start-line',
      'rationale',
      'author',
      'scope',
      'worktree'
    ],
    positionalArgs: ['path'],
    notes: [
      'The note is rendered inline beside the diff hunk with agent styling, distinct from human review notes.',
      'The path may be relative to the selected worktree or an absolute path inside that worktree.',
      '--rationale is an optional longer explanation shown below the summary.'
    ],
    examples: [
      'orca diff-note create src/App.tsx --line 42 --body "Boundary check here"',
      'orca diff-note create src/App.tsx --line 42 --body "Tighten this" --rationale "Untrusted input reaches the parser" --author claude'
    ]
  },
  {
    path: ['diff-note', 'list'],
    summary: 'List agent-authored diff notes for a worktree',
    usage: 'orca diff-note list [--path <file>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'worktree'],
    notes: ['Without --path, lists agent notes across every file in the worktree.'],
    examples: ['orca diff-note list', 'orca diff-note list --path src/App.tsx']
  },
  {
    path: ['diff-note', 'rm'],
    summary: 'Delete one agent-authored diff note',
    usage: 'orca diff-note rm --id <note-id> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'worktree'],
    notes: ['--id is the note id printed by `orca diff-note list --json`.'],
    examples: ['orca diff-note rm --id 2a1b…']
  }
]
