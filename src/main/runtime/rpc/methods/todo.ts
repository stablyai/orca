import { randomUUID } from 'crypto'
import { z } from 'zod'
import type { WorktreeTodo, WorktreeTodoScope } from '../../../../shared/types'
import {
  appendTodo,
  createTodo,
  normalizeTodoEntry,
  removeTodoById,
  setTodoCompletion,
  sortTodosForDisplay,
  toggleTodoCompletion,
  updateTodoBody
} from '../../../../shared/worktree-todo-list'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'

// Why: agent-authoring entry points (orca CLI + RPC) always stamp authorRole
// 'agent' so the UI can distinguish todos a coding agent maintains from the
// user's own list. The renderer slice supplies 'user' on its own path.
const AGENT_AUTHOR_ROLE = 'agent' as const

const TodoOwnerShape = {
  worktree: OptionalString,
  repo: OptionalString,
  scope: z.enum(['worktree', 'project']).optional()
}

const TodoList = z.object({ ...TodoOwnerShape })
const TodoAdd = z.object({ ...TodoOwnerShape, body: requiredString('Missing todo body') })
const TodoUpdate = z.object({
  ...TodoOwnerShape,
  id: requiredString('Missing todo id'),
  body: requiredString('Missing todo body')
})
const TodoComplete = z.object({
  ...TodoOwnerShape,
  id: requiredString('Missing todo id'),
  completed: OptionalBoolean
})
const TodoDelete = z.object({ ...TodoOwnerShape, id: requiredString('Missing todo id') })

type TodoOwnerParams = {
  worktree?: string
  repo?: string
  scope?: WorktreeTodoScope
}

// Why: one resolver reads the current list and returns a writer closure so each
// method does pure read-modify-write through the SAME runtime Store mutators the
// worktree.set / repo.update RPCs use — never the renderer zustand slice.
type TodoTarget = {
  scope: WorktreeTodoScope
  ownerId: string
  current: WorktreeTodo[]
  write: (todos: WorktreeTodo[]) => Promise<WorktreeTodo[]>
}

async function resolveTodoTarget(
  params: TodoOwnerParams,
  runtime: OrcaRuntimeService
): Promise<TodoTarget> {
  const wantsProject = params.scope === 'project' || (!!params.repo && !params.worktree)
  if (wantsProject) {
    if (!params.repo) {
      throw new InvalidArgumentError('Missing repo selector for project-scoped todo')
    }
    const repo = await runtime.showRepo(params.repo)
    return {
      scope: 'project',
      ownerId: repo.id,
      current: (repo.todos ?? []).map(normalizeTodoEntry),
      write: async (todos) => {
        const updated = await runtime.updateRepo(`id:${repo.id}`, { todos })
        return updated.todos ?? todos
      }
    }
  }
  if (!params.worktree) {
    throw new InvalidArgumentError('Missing worktree selector')
  }
  const worktree = await runtime.showManagedWorktree(params.worktree)
  return {
    scope: 'worktree',
    ownerId: worktree.id,
    current: (worktree.todos ?? []).map(normalizeTodoEntry),
    write: async (todos) => {
      const updated = await runtime.updateManagedWorktreeMeta(`id:${worktree.id}`, { todos })
      return updated.todos ?? todos
    }
  }
}

function findTodo(todos: readonly WorktreeTodo[], id: string): WorktreeTodo {
  const todo = todos.find((t) => t.id === id)
  if (!todo) {
    throw new InvalidArgumentError(`todo_not_found: ${id}`)
  }
  return todo
}

export const TODO_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'todo.list',
    params: TodoList,
    handler: async (params, { runtime }) => {
      const target = await resolveTodoTarget(params, runtime)
      return {
        scope: target.scope,
        ownerId: target.ownerId,
        todos: sortTodosForDisplay(target.current)
      }
    }
  }),
  defineMethod({
    name: 'todo.add',
    params: TodoAdd,
    handler: async (params, { runtime }) => {
      const body = params.body.trim()
      if (!body) {
        throw new InvalidArgumentError('Missing todo body')
      }
      const target = await resolveTodoTarget(params, runtime)
      const todo = createTodo({
        id: randomUUID(),
        scope: target.scope,
        ownerId: target.ownerId,
        body,
        authorRole: AGENT_AUTHOR_ROLE,
        now: Date.now()
      })
      const todos = await target.write(appendTodo(target.current, todo))
      return {
        scope: target.scope,
        ownerId: target.ownerId,
        todo: todos.find((t) => t.id === todo.id) ?? todo,
        todos
      }
    }
  }),
  defineMethod({
    name: 'todo.update',
    params: TodoUpdate,
    handler: async (params, { runtime }) => {
      const body = params.body.trim()
      if (!body) {
        throw new InvalidArgumentError('Missing todo body')
      }
      const target = await resolveTodoTarget(params, runtime)
      findTodo(target.current, params.id)
      const next = updateTodoBody(target.current, params.id, body, Date.now())
      // Why: null means the body already matched — report the unchanged item
      // instead of issuing a redundant disk write.
      if (!next) {
        return {
          scope: target.scope,
          ownerId: target.ownerId,
          changed: false,
          todo: findTodo(target.current, params.id),
          todos: target.current
        }
      }
      const todos = await target.write(next)
      return {
        scope: target.scope,
        ownerId: target.ownerId,
        changed: true,
        todo: todos.find((t) => t.id === params.id),
        todos
      }
    }
  }),
  defineMethod({
    name: 'todo.complete',
    params: TodoComplete,
    handler: async (params, { runtime }) => {
      const target = await resolveTodoTarget(params, runtime)
      findTodo(target.current, params.id)
      const now = Date.now()
      const next =
        params.completed === undefined
          ? toggleTodoCompletion(target.current, params.id, now)
          : setTodoCompletion(target.current, params.id, params.completed, now)
      // Why: null means the item was already in the requested state.
      if (!next) {
        return {
          scope: target.scope,
          ownerId: target.ownerId,
          changed: false,
          todo: findTodo(target.current, params.id),
          todos: target.current
        }
      }
      const todos = await target.write(next)
      return {
        scope: target.scope,
        ownerId: target.ownerId,
        changed: true,
        todo: todos.find((t) => t.id === params.id),
        todos
      }
    }
  }),
  defineMethod({
    name: 'todo.delete',
    params: TodoDelete,
    handler: async (params, { runtime }) => {
      const target = await resolveTodoTarget(params, runtime)
      const next = removeTodoById(target.current, params.id)
      if (!next) {
        throw new InvalidArgumentError(`todo_not_found: ${params.id}`)
      }
      const todos = await target.write(next)
      return { scope: target.scope, ownerId: target.ownerId, deleted: true, id: params.id, todos }
    }
  })
]
