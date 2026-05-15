import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const NOTE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['note', 'list'],
    summary: 'List project notes for the current Orca worktree',
    usage: 'orca note list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['note', 'show'],
    summary: 'Show a project note',
    usage: 'orca note show --note <selector> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'note', 'worktree']
  },
  {
    path: ['note', 'create'],
    summary: 'Create a project note',
    usage:
      'orca note create --title <title> [--body <text>|--body-file <path>|--body-stdin] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'title', 'body', 'body-file', 'body-stdin', 'worktree']
  },
  {
    path: ['note', 'append'],
    summary: 'Append Markdown to a project note',
    usage:
      'orca note append --note <selector> [--body <text>|--body-file <path>|--body-stdin] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'note', 'body', 'body-file', 'body-stdin', 'worktree']
  },
  {
    path: ['note', 'search'],
    summary: 'Search project notes',
    usage: 'orca note search --query <text> [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'worktree', 'limit']
  }
]
