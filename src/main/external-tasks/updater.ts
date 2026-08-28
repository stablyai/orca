import type { ExternalTaskDetail, ExternalTaskUpdateArgs } from '../../shared/external-task-types'
import { getAzureCliToken } from './azure-cli'
import { getExternalTask } from './client'
import { updateNinjaCliTicket } from './ninja-cli'
import { updatePlannerCliTask } from './planner-cli'

const REQUEST_TIMEOUT_MS = 12_000

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value || null
}

function azureBaseUrl(): string | null {
  const explicit = env('ORCA_AZURE_DEVOPS_API_BASE_URL')
  if (explicit) {
    return explicit
  }
  const organization = env('ORCA_AZURE_DEVOPS_ORGANIZATION')
  return organization ? `https://dev.azure.com/${encodeURIComponent(organization)}` : null
}

async function updateAzureTask(args: ExternalTaskUpdateArgs): Promise<void> {
  const token =
    env('ORCA_AZURE_DEVOPS_TOKEN') ??
    env('ORCA_AZURE_DEVOPS_PAT') ??
    env('ORCA_AZURE_DEVOPS_ACCESS_TOKEN') ??
    env('AZURE_DEVOPS_PAT')
  const baseUrl = azureBaseUrl()
  if (!baseUrl) {
    throw new Error('Azure DevOps organization is not configured')
  }
  const authToken = token ?? (await getAzureCliToken())
  const authorization = token
    ? env('ORCA_AZURE_DEVOPS_ACCESS_TOKEN')
      ? `Bearer ${token}`
      : `Basic ${Buffer.from(`:${token}`).toString('base64')}`
    : `Bearer ${authToken}`
  const patch = [
    args.title !== undefined
      ? { op: 'add', path: '/fields/System.Title', value: args.title }
      : null,
    args.status !== undefined
      ? { op: 'add', path: '/fields/System.State', value: args.status }
      : null,
    args.assignee !== undefined
      ? { op: 'add', path: '/fields/System.AssignedTo', value: args.assignee ?? '' }
      : null,
    args.description !== undefined
      ? { op: 'add', path: '/fields/System.Description', value: args.description }
      : null
  ].filter((entry) => entry !== null)
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/_apis/wit/workitems/${encodeURIComponent(args.id)}?api-version=7.1`,
    {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'Content-Type': 'application/json-patch+json'
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  )
  if (!response.ok) {
    throw new Error(`Azure DevOps update returned HTTP ${response.status}`)
  }
}

export async function updateExternalTask(args: ExternalTaskUpdateArgs): Promise<ExternalTaskDetail> {
  if (args.provider === 'planner') {
    await updatePlannerCliTask(args)
  } else if (args.provider === 'ninjaone') {
    await updateNinjaCliTicket(args)
  } else {
    await updateAzureTask(args)
  }
  return getExternalTask(args)
}
