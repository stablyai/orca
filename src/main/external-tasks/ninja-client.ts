import type {
  ExternalTask,
  ExternalTaskActivity,
  ExternalTaskDetail,
  ExternalTaskDetailSection,
  ExternalTaskEditOptions,
  ExternalTaskSelectOption
} from '../../shared/external-task-types'

const REQUEST_TIMEOUT_MS = 12_000

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value || null
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`NinjaOne returned HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export async function getNinjaToken(
  instance: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetch(`${instance.replace(/\/+$/, '')}/ws/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'monitoring management control'
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`NinjaOne authentication returned HTTP ${response.status}`)
  }
  const value = (await response.json()) as { access_token?: string }
  if (!value.access_token) {
    throw new Error('NinjaOne authentication returned no access token')
  }
  return value.access_token
}

function mapTicket(instance: string, ticket: Record<string, unknown>): ExternalTask {
  const id = String(ticket.id ?? ticket.ticketNumber ?? '')
  const status = ticket.status as { displayName?: unknown } | string | undefined
  const assignee = ticket.assignedAppUser as
    | { id?: unknown; name?: unknown; displayName?: unknown }
    | undefined
  const optionName = (value: unknown): string | undefined =>
    typeof value === 'object' && value
      ? String((value as { name?: unknown; displayName?: unknown }).name ?? (value as { displayName?: unknown }).displayName ?? '') || undefined
      : typeof value === 'string'
        ? value
        : undefined
  return {
    provider: 'ninjaone',
    id,
    identifier: String(ticket.ticketNumber ?? id),
    title: String(ticket.summary ?? ticket.subject ?? ticket.title ?? `Ticket ${id}`),
    status:
      typeof status === 'object'
        ? String(status.displayName ?? 'Open')
        : String(status ?? 'Open'),
    assignee: assignee
      ? String(assignee.displayName ?? assignee.name ?? '') || null
      : typeof ticket.assigneeName === 'string'
        ? ticket.assigneeName
        : null,
    assigneeId:
      ticket.assignedAppUserId !== undefined
        ? String(ticket.assignedAppUserId)
        : assignee?.id !== undefined
          ? String(assignee.id)
          : null,
    updatedAt:
      typeof ticket.updateTime === 'number'
        ? new Date(ticket.updateTime * 1000).toISOString()
        : typeof ticket.updatedAt === 'string'
          ? ticket.updatedAt
          : null,
    url: `${instance.replace(/\/+$/, '')}/#/ticketing/ticket/${id}`,
    description: typeof ticket.description === 'string' ? ticket.description : undefined,
    priority: optionName(ticket.priority),
    severity: optionName(ticket.severity)
  }
}

function fieldValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>
    const named =
      record.displayName ??
      record.name ??
      record.label ??
      record.value ??
      record.email ??
      record.subject
    return typeof named === 'string' && named.trim() ? named.trim() : null
  }
  return null
}

function buildSections(ticket: Record<string, unknown>): ExternalTaskDetailSection[] {
  const overview = {
    id: 'overview',
    title: 'Overview',
    fields: [
      { label: 'Status', value: fieldValue(ticket.status) },
      { label: 'Type', value: fieldValue(ticket.type) },
      { label: 'Priority', value: fieldValue(ticket.priority) },
      { label: 'Severity', value: fieldValue(ticket.severity) },
      { label: 'Source', value: fieldValue(ticket.source) }
    ].filter((field) => field.value)
  }
  const routing = {
    id: 'routing',
    title: 'Routing',
    fields: [
      { label: 'Client', value: fieldValue(ticket.clientId) },
      { label: 'Location', value: fieldValue(ticket.locationId) },
      { label: 'Primary assignee', value: fieldValue(ticket.assignedAppUserId) },
      {
        label: 'Additional assignees',
        value: Array.isArray(ticket.additionalAssignedTechnicianIds)
          ? ticket.additionalAssignedTechnicianIds.join(', ')
          : null
      },
      {
        label: 'CC',
        value: Array.isArray(ticket.ccList) ? ticket.ccList.map((entry) => fieldValue(entry)).filter(Boolean).join(', ') : null
      }
    ].filter((field) => field.value)
  }
  return [overview, routing].filter((section) => section.fields.length > 0)
}

function mapActivity(entries: Record<string, unknown>[]): ExternalTaskActivity[] {
  return entries.map((entry) => ({
    id: String(entry.id ?? crypto.randomUUID()),
    title: fieldValue(entry.type) ?? undefined,
    body:
      fieldValue(entry.body) ??
      fieldValue(entry.htmlBody)?.replace(/<[^>]+>/g, ' ')?.replace(/\s+/g, ' ').trim() ??
      'Activity entry',
    kind: fieldValue(entry.type) ?? undefined,
    author: fieldValue(entry.appUserContactUid) ?? fieldValue(entry.appUserContactId),
    createdAt:
      typeof entry.createTime === 'number'
        ? new Date(entry.createTime * 1000).toISOString()
        : null,
    isPublic: Boolean(entry.publicEntry)
  }))
}

async function credentials(): Promise<{ instance: string; token: string } | null> {
  const instance = env('ORCA_NINJAONE_INSTANCE_URL')
  const clientId = env('ORCA_NINJAONE_CLIENT_ID')
  const clientSecret = env('ORCA_NINJAONE_CLIENT_SECRET')
  if (!instance || !clientId || !clientSecret) {
    return null
  }
  return { instance, token: await getNinjaToken(instance, clientId, clientSecret) }
}

export async function getNinjaOneTask(id: string): Promise<ExternalTaskDetail> {
  const auth = await credentials()
  if (!auth) {
    throw new Error('NinjaOne is not configured')
  }
  const [ticket, activity] = await Promise.all([
    requestJson<Record<string, unknown>>(
      `${auth.instance.replace(/\/+$/, '')}/v2/ticketing/ticket/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    ),
    requestJson<Record<string, unknown>[]>(
      `${auth.instance.replace(/\/+$/, '')}/v2/ticketing/ticket/${encodeURIComponent(id)}/log-entry?pageSize=50`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    ).catch(() => [])
  ])
  const base = mapTicket(auth.instance, ticket)
  return {
    ...base,
    type: fieldValue(ticket.type) ?? undefined,
    createdAt:
      typeof ticket.createTime === 'number'
        ? new Date(ticket.createTime * 1000).toISOString()
        : null,
    dueAt:
      typeof ticket.followupTime === 'number'
        ? new Date(ticket.followupTime * 1000).toISOString()
        : null,
    tags: Array.isArray(ticket.tags)
      ? ticket.tags.map((tag) => fieldValue(tag)).filter((tag): tag is string => Boolean(tag))
      : [],
    detailSections: buildSections(ticket),
    activity: mapActivity(activity)
  }
}

export async function listNinjaOneTasks(
  query: string | undefined,
  take: number
): Promise<ExternalTask[]> {
  const auth = await credentials()
  if (!auth) {
    return []
  }
  const value = await requestJson<{ data?: Record<string, unknown>[] }>(
    `${auth.instance.replace(/\/+$/, '')}/v2/ticketing/trigger/board/1/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }
  )
  const normalizedQuery = query?.trim().toLowerCase()
  return (value.data ?? [])
    .map((ticket) => mapTicket(auth.instance, ticket))
    .filter((ticket) => !normalizedQuery || ticket.title.toLowerCase().includes(normalizedQuery))
    .slice(0, take)
}

export async function getNinjaOneEditOptions(): Promise<ExternalTaskEditOptions> {
  const auth = await credentials()
  if (!auth) {
    throw new Error('NinjaOne is not configured')
  }
  const [statuses, users] = await Promise.all([
    requestJson<{ name?: string; displayName?: string }[]>(
      `${auth.instance.replace(/\/+$/, '')}/v2/ticketing/statuses`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    ),
    requestJson<{ id?: number; firstName?: string; lastName?: string; email?: string }[]>(
      `${auth.instance.replace(/\/+$/, '')}/v2/users`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    )
  ])
  const statusOptions = statuses.flatMap<ExternalTaskSelectOption>((status) =>
    status.name
      ? [{ value: status.name, label: status.displayName ?? status.name }]
      : []
  )
  const assigneeOptions = users.flatMap<ExternalTaskSelectOption>((user) => {
    if (user.id === undefined) {
      return []
    }
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ')
    return [{ value: String(user.id), label: name || user.email || String(user.id) }]
  })
  return {
    statuses: statusOptions,
    assignees: assigneeOptions,
    priorities: ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((value) => ({ value, label: value })),
    severities: ['NONE', 'MINOR', 'MODERATE', 'MAJOR', 'CRITICAL'].map((value) => ({ value, label: value }))
  }
}
