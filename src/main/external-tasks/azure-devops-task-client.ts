import type {
  ExternalTask,
  ExternalTaskActivity,
  ExternalTaskDetail,
  ExternalTaskProviderStatus
} from '../../shared/external-task-types'
import { getAzureCliToken } from './azure-cli'

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
    throw new Error(`External task provider returned HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

function azureBaseUrl(): string | null {
  const explicit = env('ORCA_AZURE_DEVOPS_API_BASE_URL')
  if (explicit) {
    return explicit
  }
  const organization = env('ORCA_AZURE_DEVOPS_ORGANIZATION')
  return organization ? `https://dev.azure.com/${encodeURIComponent(organization)}` : null
}

async function azureHeaders(): Promise<Record<string, string>> {
  const token =
    env('ORCA_AZURE_DEVOPS_TOKEN') ??
    env('ORCA_AZURE_DEVOPS_PAT') ??
    env('ORCA_AZURE_DEVOPS_ACCESS_TOKEN') ??
    env('AZURE_DEVOPS_PAT')
  const authToken = token ?? (await getAzureCliToken())
  if (token) {
    return env('ORCA_AZURE_DEVOPS_ACCESS_TOKEN')
      ? { Authorization: `Bearer ${token}` }
      : { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` }
  }
  return { Authorization: `Bearer ${authToken}` }
}

function displayIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>
    const identity =
      record.displayName ?? record.name ?? record.uniqueName ?? record.email ?? record.descriptor
    return typeof identity === 'string' && identity.trim() ? identity.trim() : null
  }
  return null
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return displayIdentity(value)
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function azureUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/_workitems/edit/${id}`
}

function mapAzureTask(baseUrl: string, item: Record<string, unknown>): ExternalTask {
  const fields = (item.fields ?? {}) as Record<string, unknown>
  const id = String(item.id ?? '')
  return {
    provider: 'azure-devops',
    id,
    identifier: id,
    title: textValue(fields['System.Title']) ?? `Work item ${id}`,
    status: textValue(fields['System.State']) ?? 'Unknown',
    assignee: displayIdentity(fields['System.AssignedTo']),
    updatedAt: textValue(fields['System.ChangedDate']),
    url: azureUrl(baseUrl, id),
    description: typeof fields['System.Description'] === 'string' ? fields['System.Description'] : undefined,
    priority: textValue(fields['Microsoft.VSTS.Common.Priority']) ?? undefined,
    severity: textValue(fields['Microsoft.VSTS.Common.Severity']) ?? undefined
  }
}

function azureUpdateActivity(entries: Record<string, unknown>[]): ExternalTaskActivity[] {
  return entries
    .map((entry) => {
      const changedFields = Object.keys((entry.fields ?? {}) as Record<string, unknown>)
      return {
        id: `update-${String(entry.id ?? crypto.randomUUID())}`,
        title: changedFields.length > 0 ? 'Field update' : 'Revision',
        body:
          changedFields.length > 0
            ? `Changed ${changedFields.join(', ')}`
            : `Revision ${String(entry.rev ?? '')}`.trim(),
        kind: 'update',
        author: displayIdentity(entry.revisedBy),
        createdAt: textValue(entry.revisedDate),
        isPublic: false
      }
    })
    .filter((entry) => entry.body)
}

function azureCommentActivity(entries: Record<string, unknown>[]): ExternalTaskActivity[] {
  return entries.map((entry) => ({
    id: `comment-${String(entry.id ?? crypto.randomUUID())}`,
    title: 'Comment',
    body:
      stripHtml(
        typeof entry.renderedText === 'string'
          ? entry.renderedText
          : typeof entry.text === 'string'
            ? entry.text
            : undefined
      ) ?? 'Comment',
    kind: 'comment',
    author: displayIdentity(entry.createdBy),
    createdAt: textValue(entry.createdDate),
    isPublic: true
  }))
}

export async function getAzureDevOpsStatus(): Promise<ExternalTaskProviderStatus> {
  const provider = 'azure-devops'
  try {
    const baseUrl = azureBaseUrl()
    if (!baseUrl) {
      return { provider, configured: false, authenticated: false, account: null }
    }
    const value = await requestJson<{ authenticatedUser?: { displayName?: string } }>(
      `${baseUrl.replace(/\/+$/, '')}/_apis/connectionData?connectOptions=none&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1`,
      { headers: await azureHeaders() }
    )
    return {
      provider,
      configured: true,
      authenticated: true,
      account: value.authenticatedUser?.displayName ?? null
    }
  } catch (error) {
    return {
      provider,
      configured: true,
      authenticated: false,
      account: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function getAzureDevOpsTask(id: string): Promise<ExternalTaskDetail> {
  const baseUrl = azureBaseUrl()
  if (!baseUrl) {
    throw new Error('Azure DevOps organization is not configured')
  }
  const headers = await azureHeaders()
  const [item, comments, updates] = await Promise.all([
    requestJson<Record<string, unknown>>(
      `${baseUrl.replace(/\/+$/, '')}/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=all&api-version=7.1`,
      { headers }
    ),
    requestJson<{ comments?: Record<string, unknown>[] }>(
      `${baseUrl.replace(/\/+$/, '')}/_apis/wit/workItems/${encodeURIComponent(id)}/comments?api-version=7.1-preview.4`,
      { headers }
    ).catch(() => ({ comments: [] })),
    requestJson<{ value?: Record<string, unknown>[] }>(
      `${baseUrl.replace(/\/+$/, '')}/_apis/wit/workItems/${encodeURIComponent(id)}/updates?api-version=7.1`,
      { headers }
    ).catch(() => ({ value: [] }))
  ])
  const fields = (item.fields ?? {}) as Record<string, unknown>
  const base = mapAzureTask(baseUrl, item)
  const tags =
    typeof fields['System.Tags'] === 'string'
      ? fields['System.Tags'].split(';').map((tag) => tag.trim()).filter(Boolean)
      : []
  const activity = [...azureCommentActivity(comments.comments ?? []), ...azureUpdateActivity(updates.value ?? [])]
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
  return {
    ...base,
    type: textValue(fields['System.WorkItemType']) ?? undefined,
    requester: displayIdentity(fields['System.CreatedBy']) ?? undefined,
    createdAt: textValue(fields['System.CreatedDate']),
    completedAt: textValue(fields['Microsoft.VSTS.Common.ResolvedDate']),
    tags,
    detailSections: [
      {
        id: 'classification',
        title: 'Classification',
        fields: [
          { label: 'Type', value: textValue(fields['System.WorkItemType']) },
          { label: 'State', value: textValue(fields['System.State']) },
          { label: 'Reason', value: textValue(fields['System.Reason']) },
          { label: 'Priority', value: textValue(fields['Microsoft.VSTS.Common.Priority']) },
          { label: 'Severity', value: textValue(fields['Microsoft.VSTS.Common.Severity']) }
        ].filter((field) => field.value)
      },
      {
        id: 'scope',
        title: 'Scope',
        fields: [
          { label: 'Project', value: textValue(fields['System.TeamProject']) },
          { label: 'Area path', value: textValue(fields['System.AreaPath']) },
          { label: 'Iteration path', value: textValue(fields['System.IterationPath']) },
          { label: 'Assigned to', value: displayIdentity(fields['System.AssignedTo']) }
        ].filter((field) => field.value)
      }
    ],
    activity
  }
}

export async function listAzureDevOpsTasks(
  query: string | undefined,
  take: number
): Promise<ExternalTask[]> {
  const baseUrl = azureBaseUrl()
  if (!baseUrl) {
    return []
  }
  const wiql = query?.trim()
    ? `SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS '${query
        .trim()
        .replaceAll("'", "''")}' ORDER BY [System.ChangedDate] DESC`
    : 'SELECT [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC'
  const result = await requestJson<{ workItems?: { id: number }[] }>(
    `${baseUrl.replace(/\/+$/, '')}/_apis/wit/wiql?api-version=7.1-preview.2`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await azureHeaders())
      },
      body: JSON.stringify({ query: wiql })
    }
  )
  const ids = (result.workItems ?? []).slice(0, take).map((item) => item.id)
  if (ids.length === 0) {
    return []
  }
  const details = await requestJson<{ value?: Record<string, unknown>[] }>(
    `${baseUrl.replace(/\/+$/, '')}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=all&api-version=7.1`,
    { headers: await azureHeaders() }
  )
  return (details.value ?? []).map((item) => mapAzureTask(baseUrl, item))
}
