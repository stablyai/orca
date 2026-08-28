import type {
  ExternalTask,
  ExternalTaskDetail,
  ExternalTaskDetailArgs,
  ExternalTaskListArgs,
  ExternalTaskProvider,
  ExternalTaskProviderStatus
} from '../../shared/external-task-types'
import {
  getAzureDevOpsStatus,
  getAzureDevOpsTask,
  listAzureDevOpsTasks
} from './azure-devops-task-client'
import { getNinjaOneTask, getNinjaToken, listNinjaOneTasks } from './ninja-client'
import { getPlannerCliStatus, getPlannerCliTask, listPlannerCliTasks } from './planner-cli'

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value || null
}

function limit(value: number | undefined): number {
  return Math.min(Math.max(Number.isFinite(value) ? Number(value) : 50, 1), 100)
}

export async function getExternalTaskProviderStatus(
  provider: ExternalTaskProvider
): Promise<ExternalTaskProviderStatus> {
  if (provider === 'azure-devops') {
    return getAzureDevOpsStatus()
  }
  if (provider === 'planner') {
    const token =
      env('ORCA_PLANNER_ACCESS_TOKEN') ??
      env('PLANNER_ACCESS_TOKEN') ??
      env('MICROSOFT_GRAPH_ACCESS_TOKEN')
    if (!token) {
      return getPlannerCliStatus(provider)
    }
    try {
      const response = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      })
      if (!response.ok) {
        throw new Error(`External task provider returned HTTP ${response.status}`)
      }
      const value = (await response.json()) as {
        userPrincipalName?: string
        displayName?: string
      }
      return {
        provider,
        configured: true,
        authenticated: true,
        account: value.displayName ?? value.userPrincipalName ?? null
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
  try {
    const instance = env('ORCA_NINJAONE_INSTANCE_URL')
    const clientId = env('ORCA_NINJAONE_CLIENT_ID')
    const clientSecret = env('ORCA_NINJAONE_CLIENT_SECRET')
    if (!instance || !clientId || !clientSecret) {
      return { provider, configured: false, authenticated: false, account: null }
    }
    await getNinjaToken(instance, clientId, clientSecret)
    return { provider, configured: true, authenticated: true, account: instance }
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

export async function listExternalTasks(args: ExternalTaskListArgs): Promise<ExternalTask[]> {
  const take = limit(args.limit)
  if (args.provider === 'azure-devops') {
    return listAzureDevOpsTasks(args.query, take)
  }
  if (args.provider === 'planner') {
    return listPlannerCliTasks(args.query, take)
  }
  return listNinjaOneTasks(args.query, take)
}

export async function getExternalTask(args: ExternalTaskDetailArgs): Promise<ExternalTaskDetail> {
  if (args.provider === 'azure-devops') {
    return getAzureDevOpsTask(args.id)
  }
  if (args.provider === 'planner') {
    return getPlannerCliTask(args.id)
  }
  return getNinjaOneTask(args.id)
}
