// Sample task source. The worker returns data; Orca renders it. Every method
// answers the same envelope, so a failure can never read as an empty board.
const ITEMS = [
  {
    id: '1',
    key: 'DEMO-1',
    title: 'Ship the task source platform',
    state: { name: 'Active', category: 'in-progress' },
    assignee: null,
    url: null,
    updatedAt: '2026-09-20T10:00:00.000Z',
    scopeId: 'demo'
  }
]

export default function activate(orca) {
  orca.taskSources.register('demo-tasks', {
    status: () => ({
      ok: true,
      data: {
        connected: true,
        accountLabel: 'Demo',
        notice: null,
        supports: {
          create: false,
          comment: false,
          transition: false,
          assign: false,
          editTitle: false,
          editDescription: false
        }
      }
    }),
    listScopes: () => ({
      ok: true,
      data: [{ id: 'demo', name: 'Demo project', isDefault: true }]
    }),
    listItems: () => ({ ok: true, data: { items: ITEMS, nextCursor: null } }),
    getItem: (params) => {
      const item = ITEMS.find((entry) => entry.id === params?.id)
      return item
        ? { ok: true, data: item }
        : { ok: false, code: 'not_found', message: `no item ${params?.id}` }
    }
  })
}
