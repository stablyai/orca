// Sample Orca task source. The worker returns plain data; Orca validates it,
// renders the list on the Tasks page, and turns `start` into a prefilled
// Create workspace dialog the user reviews before anything is created.
const TASKS = [
  {
    id: 'login-form',
    title: 'Wire up the login form',
    status: { label: 'Open', tone: 'open' },
    priority: 'P1',
    owner: 'sam@example.com',
    labels: ['ui', 'auth'],
    updatedAt: '2026-10-01',
    body: '## Goal\n\nUsers can sign in with email and password.\n\n- [ ] Fields and labels\n- [ ] Client-side validation\n- [ ] Error banner',
    start: {
      workspaceName: 'login-form',
      agentPrompt: 'Build the login form described in docs/login.md, with tests.',
      sessionOptions: { agent: 'claude', model: 'sonnet', effort: 'high' },
      linkMetadata: { spec: 'docs/login.md' }
    }
  },
  {
    id: 'flaky-upload-test',
    title: 'Fix the flaky upload test',
    status: { label: 'In progress', tone: 'active' },
    priority: 'P0',
    owner: 'alex@example.com',
    labels: ['tests'],
    updatedAt: '2026-10-04',
    body: 'The upload test fails about one run in ten on CI.',
    start: {
      workspaceName: 'flaky-upload-test',
      agentPrompt: 'Find why the upload test is flaky and fix the cause, not the symptom.'
    }
  },
  {
    id: 'settings-review',
    title: 'Design review of the settings page',
    status: { label: 'Blocked', tone: 'blocked' },
    priority: 'P2',
    labels: ['design'],
    updatedAt: '2026-09-28',
    body: 'Waiting on the new spacing tokens.',
    startBlockedReason: 'Needs a designer, not an agent'
  }
]

const STATUS_FILTER = {
  id: 'status',
  label: 'Status',
  defaultValue: 'all',
  options: [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'active', label: 'In progress' },
    { value: 'blocked', label: 'Blocked' }
  ]
}

function toItem(task) {
  const { body: _body, ...item } = task
  return item
}

// Settings hold only what the user changed, so apply the manifest's defaults here.
async function readShowBlocked(orca) {
  const { settings } = await orca.host.call('settings.get')
  return settings.showBlocked !== false
}

export default function activate(orca) {
  orca.tasks.registerSource('samples', {
    async list({ query, filters }) {
      const status = filters.status ?? STATUS_FILTER.defaultValue
      const needle = query.toLowerCase()
      const showBlocked = await readShowBlocked(orca)
      const items = TASKS.filter(
        (task) =>
          (status === 'all' || task.status.tone === status) &&
          (showBlocked || task.status.tone !== 'blocked') &&
          (!needle || task.title.toLowerCase().includes(needle))
      ).map(toItem)
      return { items, filters: [STATUS_FILTER] }
    },
    get({ itemId }) {
      const task = TASKS.find((candidate) => candidate.id === itemId)
      if (!task) {
        throw new Error(`no sample task ${itemId}`)
      }
      return { item: toItem(task), bodyMarkdown: task.body }
    }
  })
}
