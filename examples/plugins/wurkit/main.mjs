const API_ROOT = 'https://api.wurkit.app/api/rest'
const OPEN_STATUSES = ['planning', 'backlog', 'todo', 'in_progress', 'blocked', 'in_review']
const PAGE_SIZE = 100

function failHostCall(result, action) {
  if (!result?.ok) {
    throw new Error(`${action} failed: ${result?.error || result?.code || 'host unavailable'}`)
  }
  return result.value
}

async function secret(key) {
  const result = await orca.host.call('secrets.get', { key })
  return failHostCall(result, 'Reading the Wurkit key')?.value ?? null
}

async function requestList(path, apiKey, signal) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    redirect: 'error',
    signal
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body?.error?.message || `Wurkit returned HTTP ${response.status}`
    throw new Error(message)
  }
  if (!Array.isArray(body?.data?.items)) {
    throw new Error('Wurkit returned an invalid list response')
  }
  return {
    items: body.data.items,
    hasMore: typeof body.data.nextCursor === 'string' && body.data.nextCursor.length > 0
  }
}

function encodeQuery(values) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return `?${params.toString()}`
}

export default function activate(orca) {
  orca.commands.register('wurkit.save-key', async (args) => {
    const apiKey = args && typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
    if (!apiKey || apiKey.length > 64 * 1024) throw new Error('Enter a valid Wurkit API key')
    const result = await orca.host.call('secrets.set', { key: 'api-key', value: apiKey })
    failHostCall(result, 'Saving the Wurkit key')
    return { saved: true }
  })

  orca.commands.register('wurkit.load', async (args) => {
    const apiKey = await secret('api-key')
    if (!apiKey) throw new Error('Add a Wurkit API key first')
    const projectId = args && typeof args.projectId === 'string' ? args.projectId : undefined
    const signal = AbortSignal.timeout(15000)
    const [projectResult, agentResult, ticketsByStatus] = await Promise.all([
      requestList('/projects?limit=100', apiKey, signal),
      requestList('/agents?limit=100', apiKey, signal),
      Promise.all(
        OPEN_STATUSES.map(async (status) => ({
          status,
          ...(await requestList(
            `/packages${encodeQuery({ status, projectId, limit: PAGE_SIZE, fields: 'compact' })}`,
            apiKey,
            signal
          ))
        }))
      )
    ])
    const assignees = new Map(
      agentResult.items.map((agent) => [agent.id, agent.displayName || agent.handle])
    )
    const tickets = ticketsByStatus
      .flatMap((result) => result.items)
      .map((ticket) => ({
        id: ticket.id,
        identifier: ticket.identifier,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        projectId: ticket.projectId,
        assignee: ticket.assignedAgentId
          ? assignees.get(ticket.assignedAgentId) || 'Assigned agent'
          : 'Unassigned',
        updatedAt: ticket.updatedAt || null
      }))
      .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
    return {
      projects: projectResult.items.map((project) => ({
        id: project.id,
        slug: project.slug,
        identifierSlug: project.identifierSlug,
        name: project.name
      })),
      tickets,
      projectsTruncated: projectResult.hasMore,
      truncatedStatuses: ticketsByStatus
        .filter((result) => result.hasMore)
        .map((result) => result.status),
      refreshedAt: new Date().toISOString()
    }
  })
}
