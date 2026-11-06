import { atom, derived, read, set, update } from 'orca'

export type Todo = { id: number; title: string; done: boolean }

// Keyed and persisted: the list survives closing the panel and restarting Orca.
export const todos = atom<Todo[]>(
  'todos',
  [
    { id: 1, title: 'Read the components guide', done: true },
    { id: 2, title: 'Edit src/panel.tsx and save', done: false }
  ],
  { persist: 'plugin' }
)
// Keyed, in memory: a save in a development folder hot reloads the panel and keeps the draft.
export const draft = atom('draft', '')
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
