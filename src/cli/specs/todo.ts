import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: scope defaults to the current worktree; --project (optionally with a
// repo selector) or --scope project targets the per-project list instead.
const SCOPE_FLAGS = ['worktree', 'repo', 'project', 'scope']

const SCOPE_NOTE =
  'Defaults to the current worktree. Use --project [<repo-selector>], --repo <repo-selector>, or --scope project for the per-project list.'

export const TODO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['todo', 'list'],
    summary: 'List native todos for the current worktree or project',
    usage: 'orca todo list [--worktree <selector>] [--project [<repo-selector>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS],
    notes: [SCOPE_NOTE],
    examples: ['orca todo list', 'orca todo list --project', 'orca todo list --json']
  },
  {
    path: ['todo', 'add'],
    summary: 'Add an agent-authored todo (authorRole: agent)',
    usage: 'orca todo add <body> [--worktree <selector>] [--project [<repo-selector>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'body'],
    positionalArgs: ['body'],
    notes: [SCOPE_NOTE, 'Todos created here are marked authorRole: agent.'],
    examples: [
      'orca todo add "Wire up the new endpoint"',
      'orca todo add "Update changelog" --project'
    ]
  },
  {
    path: ['todo', 'update'],
    summary: 'Update the body of an existing todo',
    usage: 'orca todo update <id> --body <text> [--project [<repo-selector>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'id', 'body'],
    positionalArgs: ['id'],
    notes: [SCOPE_NOTE],
    examples: ['orca todo update 7f3c... --body "Refine the endpoint contract"']
  },
  {
    path: ['todo', 'complete'],
    summary: 'Mark a todo complete (or re-open it with --reopen)',
    usage: 'orca todo complete <id> [--reopen] [--project [<repo-selector>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'id', 'reopen'],
    positionalArgs: ['id'],
    notes: [SCOPE_NOTE],
    examples: ['orca todo complete 7f3c...', 'orca todo complete 7f3c... --reopen']
  },
  {
    path: ['todo', 'delete'],
    summary: 'Delete a todo',
    usage: 'orca todo delete <id> [--project [<repo-selector>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [SCOPE_NOTE],
    examples: ['orca todo delete 7f3c...']
  }
]
