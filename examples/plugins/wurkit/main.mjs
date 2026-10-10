const API_ORIGIN = 'https://wurkit-production.up.railway.app'
const API_KEY_NAME = 'wurkit-api-key'
const OPEN_STATUSES = new Set([
  'planning',
  'backlog',
  'todo',
  'in_progress',
  'blocked',
  'in_review'
])
const REQUEST_TIMEOUT_MS = 15_000

export default function activate(orca) {
  orca.commands.register('configure', async (args) => {
    const apiKey = typeof args?.apiKey === 'string' ? args.apiKey.trim() : ''
    if (!apiKey || apiKey.length > 4096) throw new Error('Enter a valid Wurkit API key.')
    const stored = await orca.host.call('secrets.set', { key: API_KEY_NAME, value: apiKey })
    if (!stored.ok) throw new Error(stored.error || 'Could not save the Wurkit API key.')
    return { configured: true }
  })

  orca.commands.register('projects', async () => {
    const key = await getApiKey(orca)
    if (!key) return { configured: false, projects: [] }
    const projects = await requestWurkit(key, '/projects?limit=100')
    if (!Array.isArray(projects)) throw new Error('Wurkit returned an invalid project list.')
    return {
      configured: true,
      projects: projects.map((project) => ({
        id: project.id,
        identifierSlug: project.identifierSlug,
        name: project.name
      }))
    }
  })

  orca.commands.register('packages', async (args) => {
    const key = await getApiKey(orca)
    if (!key) return { configured: false, items: [], nextCursor: null, total: 0 }
    const projectId = typeof args?.projectId === 'string' ? args.projectId : ''
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error('Choose a Wurkit project.')
    const cursor = typeof args?.cursor === 'string' ? args.cursor : ''
    const query = new URLSearchParams({ projectId, fields: 'compact', limit: '100' })
    if (cursor) query.set('cursor', cursor)
    const page = await requestWurkit(key, `/packages?${query.toString()}`)
    if (!page || !Array.isArray(page.items))
      throw new Error('Wurkit returned an invalid ticket list.')
    return {
      configured: true,
      total: typeof page.total === 'number' ? page.total : page.items.length,
      nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
      items: page.items
        .filter((item) => OPEN_STATUSES.has(item.status))
        .map((item) => ({
          identifier: item.identifier,
          title: item.title,
          status: item.status,
          assignedAgentId: item.assignedAgentId,
          assignedHumanId: item.assignedHumanId
        }))
    }
  })

  orca.commands.register('status', async () => ({ configured: Boolean(await getApiKey(orca)) }))
}

async function getApiKey(orca) {
  const result = await orca.host.call('secrets.get', { key: API_KEY_NAME })
  if (!result.ok) throw new Error(result.error || 'Could not read the encrypted Wurkit API key.')
  return typeof result.value?.value === 'string' ? result.value.value : ''
}

async function requestWurkit(apiKey, path) {
  const response = await fetch(new URL(`/api/rest${path}`, API_ORIGIN), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || typeof body !== 'object' || !('data' in body)) {
    throw new Error(`Wurkit request failed (HTTP ${response.status}).`)
  }
  return body.data
}
