// The plugin's own worker, started by the panel's first `plugin.request`. It answers
// `tasks.suggest` from the `suggestions` setting, and watches the task list the panel keeps in
// storage (`persist: 'storage'`) to post `tasks.allDone`.

/** @param {unknown} todos */
const openCount = (todos) => (Array.isArray(todos) ? todos.filter((todo) => !todo.done).length : 0)

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  // Null until the panel first stores its list, so finishing the starting tasks still counts.
  const stored = await orca.storage.get('todos')
  let open = stored === null ? null : openCount(stored)

  orca.panels.handle('tasks.suggest', async ({ taken }) => {
    const ideas = String((await orca.settings.get('suggestions')) ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if ((await orca.settings.get('suggestionOrder')) === 'reversed') {
      ideas.reverse()
    }
    return { title: ideas.find((idea) => !taken.includes(idea)) ?? null }
  })

  orca.storage.onDidChange(async ({ key }) => {
    if (key !== 'todos') {
      return
    }
    const todos = await orca.storage.get('todos')
    const nowOpen = openCount(todos)
    const count = Array.isArray(todos) ? todos.length : 0
    if (
      open !== 0 &&
      nowOpen === 0 &&
      count > 0 &&
      (await orca.settings.get('celebrate')) !== false
    ) {
      orca.panels.post('tasks.allDone', { count })
    }
    open = nowOpen
  })
}
