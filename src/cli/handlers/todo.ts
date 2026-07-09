import type { CommandHandler } from '../dispatch'
import {
  formatTodoDelete,
  formatTodoList,
  formatTodoMutation,
  printResult,
  type TodoDeleteResult,
  type TodoListResult,
  type TodoMutationResult
} from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'

type TodoTarget = {
  worktree?: string
  repo?: string
  scope?: 'project'
}

// Why: worktree ids embed the repo id as `repoId::worktreeId`, so the project
// scope can fall back to the current worktree's repo when no selector is given.
function deriveRepoSelectorFromWorktreeSelector(selector: string): string | undefined {
  if (!selector.startsWith('id:')) {
    return undefined
  }
  const worktreeId = selector.slice('id:'.length)
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

async function resolveTodoTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<TodoTarget> {
  const scopeFlag = getOptionalStringFlag(flags, 'scope')
  if (scopeFlag && scopeFlag !== 'worktree' && scopeFlag !== 'project') {
    throw new RuntimeClientError('invalid_argument', '--scope must be worktree or project')
  }
  const isProject =
    scopeFlag === 'project' ||
    (scopeFlag !== 'worktree' && (flags.has('project') || flags.has('repo')))
  if (isProject) {
    const explicit = getOptionalStringFlag(flags, 'project') ?? getOptionalStringFlag(flags, 'repo')
    if (explicit) {
      return { repo: explicit, scope: 'project' }
    }
    const repo = deriveRepoSelectorFromWorktreeSelector(
      await resolveCurrentWorktreeSelector(cwd, client)
    )
    if (!repo) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Could not resolve a project. Pass --project <repo-selector> or --repo <repo-selector>.'
      )
    }
    return { repo, scope: 'project' }
  }
  const worktree =
    (await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)) ??
    (await resolveCurrentWorktreeSelector(cwd, client))
  return { worktree }
}

export const TODO_HANDLERS: Record<string, CommandHandler> = {
  'todo list': async ({ flags, client, cwd, json }) => {
    const target = await resolveTodoTarget(flags, cwd, client)
    const result = await client.call<TodoListResult>('todo.list', target)
    printResult(result, json, formatTodoList)
  },
  'todo add': async ({ flags, client, cwd, json }) => {
    const target = await resolveTodoTarget(flags, cwd, client)
    const result = await client.call<TodoMutationResult>('todo.add', {
      ...target,
      body: getRequiredStringFlag(flags, 'body')
    })
    printResult(result, json, formatTodoMutation)
  },
  'todo update': async ({ flags, client, cwd, json }) => {
    const target = await resolveTodoTarget(flags, cwd, client)
    const result = await client.call<TodoMutationResult>('todo.update', {
      ...target,
      id: getRequiredStringFlag(flags, 'id'),
      body: getRequiredStringFlag(flags, 'body')
    })
    printResult(result, json, formatTodoMutation)
  },
  'todo complete': async ({ flags, client, cwd, json }) => {
    const target = await resolveTodoTarget(flags, cwd, client)
    const result = await client.call<TodoMutationResult>('todo.complete', {
      ...target,
      id: getRequiredStringFlag(flags, 'id'),
      // Why: --reopen re-opens a finished item; otherwise the command marks done.
      completed: flags.get('reopen') !== true
    })
    printResult(result, json, formatTodoMutation)
  },
  'todo delete': async ({ flags, client, cwd, json }) => {
    const target = await resolveTodoTarget(flags, cwd, client)
    const result = await client.call<TodoDeleteResult>('todo.delete', {
      ...target,
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatTodoDelete)
  }
}
