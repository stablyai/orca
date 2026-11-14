import { atom, derived, read, set, update } from 'orca'

export type Todo = { id: number; title: string; done: boolean }

// Kept in the plugin's own storage under `todos`: it survives restarts, and the worker reads it.
export const todos = atom<Todo[]>(
  'todos',
  [
    { id: 1, title: 'Read the components guide', done: true },
    { id: 2, title: 'Edit src/panel.tsx and save', done: false }
  ],
  { persist: 'storage' }
)
export const draft = atom('')
export const openCount = derived(() => read(todos).filter((todo) => !todo.done).length)
export const percentDone = derived(() => {
  const list = read(todos)
  return list.length === 0 ? 100 : Math.round((100 * (list.length - read(openCount))) / list.length)
})

export function add(): void {
  const title = read(draft).trim()
  if (!title) {
    return
  }
  update(todos, (list) => [
    ...list,
    { id: Math.max(0, ...list.map((todo) => todo.id)) + 1, title, done: false }
  ])
  set(draft, '')
}

export function toggle(id: number): void {
  update(todos, (list) =>
    list.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo))
  )
}

export function clearDone(): void {
  update(todos, (list) => list.filter((todo) => !todo.done))
}
