const TAPD_API = 'https://api.tapd.cn/'
const PAGE_SIZE = 30
const TAPD_ID = /^[1-9]\d{0,29}$/
const TYPES = new Map([
  [
    'story',
    { route: 'stories', wrapper: 'Story', title: 'name', owner: 'owner', label: 'Requirement' }
  ],
  ['bug', { route: 'bugs', wrapper: 'Bug', title: 'title', owner: 'current_owner', label: 'Bug' }],
  ['task', { route: 'tasks', wrapper: 'Task', title: 'name', owner: 'owner', label: 'Task' }]
])
const TYPE_FILTER = {
  id: 'kind',
  label: 'Type',
  defaultValue: 'story',
  options: [...TYPES].map(([value, { label }]) => ({ value, label }))
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

async function readConfiguration(orca) {
  const { settings } = await orca.host.call('settings.get')
  const { value: token } = await orca.host.call('secrets.get', { key: 'tapd-token' })
  return {
    projectId: boundedText(settings.tapdProjectId, 31),
    projectPath: boundedText(settings.orcaProjectPath, 4097),
    token
  }
}

function buildParams(projectId, type, detail) {
  const fields = [
    'id',
    'workspace_id',
    type.title,
    type.owner,
    'status',
    'priority_label',
    'modified'
  ]
  if (detail) {
    fields.push('description')
  }
  const params = new URLSearchParams({ workspace_id: projectId, fields: fields.join(',') })
  if (type.wrapper === 'Story') {
    params.set('with_v_status', '1')
  }
  return params
}

async function getRows(type, params, token, signal) {
  const url = new URL(type.route, TAPD_API)
  url.search = params.toString()
  const timeout = AbortSignal.timeout(12_000)
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) {
    throw new Error(`TAPD returned HTTP ${response.status}`)
  }
  const result = await response.json()
  if (result?.status !== 1 || !Array.isArray(result.data)) {
    throw new Error('TAPD did not return a work item list')
  }
  return result.data
}

function readDescription(value) {
  return boundedText(value, 120_000)
    .replace(/<\/?(?:p|div|li)\b[^>]*>|<br\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .trim()
    .slice(0, 12_000)
}

function toTask(row, kind, type, { projectId, projectPath }, includeDescription = false) {
  const raw = row?.[type.wrapper]
  const id = raw?.id
  const title = boundedText(raw?.[type.title], 512)
  if (
    typeof id !== 'string' ||
    !TAPD_ID.test(id) ||
    String(raw.workspace_id) !== projectId ||
    !title
  ) {
    throw new Error('TAPD returned an invalid work item')
  }
  const url = `https://www.tapd.cn/tapd_fe/${projectId}/${kind}/detail/${id}`
  const status = boundedText(raw.v_status || raw.status, 64)
  const owner = boundedText(raw[type.owner], 256).replace(/;+/g, ', ').replace(/, $/, '')
  const priority = boundedText(raw.priority_label, 32)
  const modified = boundedText(raw.modified, 64)
  const description = includeDescription ? readDescription(raw.description) : ''
  const draft = [`TAPD ${type.label} #${id}`, title, url]
  if (description) {
    draft.push('', 'Description from TAPD (task context):', description)
  }
  return {
    item: {
      id: `${kind}:${projectId}:${id}`,
      title,
      url,
      ...(status ? { status: { label: status, tone: 'open' } } : {}),
      ...(owner ? { owner: owner.slice(0, 256) } : {}),
      ...(priority ? { priority } : {}),
      ...(modified ? { updatedAt: modified.replace(' ', 'T') } : {}),
      ...(projectPath && projectPath.length <= 4096
        ? {
            start: {
              projectPath,
              workspaceName: `tapd-${kind}-${id}`,
              agentPrompt: draft.join('\n')
            }
          }
        : { startBlockedReason: 'Set the Orca project folder in the TAPD Tasks plugin settings.' })
    },
    ...(description
      ? {
          bodyMarkdown: description
            .replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
            .replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&')
        }
      : {})
  }
}

export default function activate(orca) {
  orca.tasks.registerSource('tapd', {
    async list({ query, filters, cursor }, { signal } = {}) {
      const configuration = await readConfiguration(orca)
      if (!TAPD_ID.test(configuration.projectId) || !configuration.token) {
        return {
          items: [],
          filters: [TYPE_FILTER],
          notice: 'Set the TAPD project ID in plugin settings and save a token in TAPD Connection.'
        }
      }
      const kind = TYPES.has(filters.kind) ? filters.kind : 'story'
      const type = TYPES.get(kind)
      const params = buildParams(configuration.projectId, type, false)
      const page = cursor ? Number(cursor) : 1
      if (!Number.isSafeInteger(page) || page < 1 || page >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid TAPD page')
      }
      params.set('limit', String(PAGE_SIZE))
      params.set('page', String(page))
      params.set('order', 'modified desc')
      const search = query.trim()
      if (search) {
        const id = search.replace(/^#/, '')
        const isId = TAPD_ID.test(id) && (id.length >= 19 || search.startsWith('#'))
        params.set(isId ? 'id' : type.title, isId ? id : search)
      }

      const rows = await getRows(type, params, configuration.token, signal)
      return {
        items: rows.map((row) => toTask(row, kind, type, configuration).item),
        filters: [TYPE_FILTER],
        ...(rows.length === PAGE_SIZE ? { nextCursor: String(page + 1) } : {})
      }
    },
    async get({ itemId }, { signal } = {}) {
      const configuration = await readConfiguration(orca)
      const [kind, projectId, id, extra] = itemId.split(':')
      const type = TYPES.get(kind)
      if (
        extra !== undefined ||
        !type ||
        !TAPD_ID.test(id ?? '') ||
        !TAPD_ID.test(projectId ?? '') ||
        projectId !== configuration.projectId ||
        !configuration.token
      ) {
        throw new Error('This work item does not belong to the configured TAPD project')
      }
      const params = buildParams(projectId, type, true)
      params.set('id', id)
      params.set('limit', '1')
      const rows = await getRows(type, params, configuration.token, signal)
      if (rows.length !== 1 || rows[0]?.[type.wrapper]?.id !== id) {
        throw new Error('TAPD work item not found')
      }
      return toTask(rows[0], kind, type, configuration, true)
    }
  })
}
