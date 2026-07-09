import type { WorktreeTodo, WorktreeTodoScope } from '../shared/types'

export type TodoListResult = {
  scope: WorktreeTodoScope
  ownerId: string
  todos: WorktreeTodo[]
}

export type TodoMutationResult = {
  scope: WorktreeTodoScope
  ownerId: string
  changed?: boolean
  todo?: WorktreeTodo
  todos: WorktreeTodo[]
}

export type TodoDeleteResult = {
  scope: WorktreeTodoScope
  ownerId: string
  deleted: boolean
  id: string
  todos: WorktreeTodo[]
}

function formatTodoLine(todo: WorktreeTodo): string {
  const checkbox = typeof todo.completedAt === 'number' ? '[x]' : '[ ]'
  return `${checkbox} ${todo.body}  (${todo.id}, ${todo.authorRole})`
}

export function formatTodoList(result: TodoListResult): string {
  const header = `${result.scope} todos for ${result.ownerId} (${result.todos.length})`
  if (result.todos.length === 0) {
    return `${header}\n(no todos)`
  }
  return [header, ...result.todos.map(formatTodoLine)].join('\n')
}

export function formatTodoMutation(result: TodoMutationResult): string {
  if (result.changed === false) {
    return result.todo ? `unchanged: ${formatTodoLine(result.todo)}` : 'unchanged'
  }
  return result.todo ? formatTodoLine(result.todo) : `${result.scope} todos: ${result.todos.length}`
}

export function formatTodoDelete(result: TodoDeleteResult): string {
  return `deleted: ${result.id}`
}
