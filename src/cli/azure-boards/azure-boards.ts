import type {
  AzureBoardsConnection,
  AzureDevOpsWorkItemComment,
  AzureDevOpsWorkItemSearchPage
} from '../../shared/azure-devops/azure-boards-agent-types'
import type {
  AzureDevOpsAssignedWorkItemsPage,
  AzureDevOpsTeam,
  AzureDevOpsWorkItemDetail
} from '../../shared/azure-devops/boards-types'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../arguments/flags'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  formatAzureBoardsComments,
  formatAzureBoardsConnection,
  formatAzureBoardsTeams,
  formatAzureBoardsWorkItem,
  formatAzureBoardsWorkItemList
} from './azure-boards-format'
import { resolveAzureBoardsRepo } from './azure-boards-target'

function workItemId(context: HandlerContext): number {
  const raw = getRequiredStringFlag(context.flags, 'id').trim().replace(/^#/, '')
  const id = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new RuntimeClientError('invalid_argument', 'Expected a numeric work item id.')
  }
  return id
}

export const AZURE_BOARDS_HANDLERS: Record<string, CommandHandler> = {
  'azure-boards connection': async (context) => {
    const repo = await resolveAzureBoardsRepo(context)
    const response = await context.client.call<AzureBoardsConnection>('azureBoards.connection', {
      repo
    })
    printResult(response, context.json, formatAzureBoardsConnection)
  },
  'azure-boards item': async (context) => {
    const id = workItemId(context)
    const repo = await resolveAzureBoardsRepo(context)
    const response = await context.client.call<AzureDevOpsWorkItemDetail | null>(
      'azureBoards.workItem',
      { repo, id }
    )
    printResult(response, context.json, formatAzureBoardsWorkItem)
  },
  'azure-boards comment list': async (context) => {
    const id = workItemId(context)
    const limit = getOptionalPositiveIntegerFlag(context.flags, 'limit')
    const repo = await resolveAzureBoardsRepo(context)
    const response = await context.client.call<AzureDevOpsWorkItemComment[]>(
      'azureBoards.workItemComments',
      { repo, id, limit }
    )
    printResult(response, context.json, formatAzureBoardsComments)
  },
  'azure-boards search': async (context) => {
    const wiql = getRequiredStringFlag(context.flags, 'wiql').trim()
    if (!wiql) {
      throw new RuntimeClientError('invalid_argument', 'WIQL cannot be blank.')
    }
    const limit = getOptionalPositiveIntegerFlag(context.flags, 'limit')
    const repo = await resolveAzureBoardsRepo(context)
    const response = await context.client.call<AzureDevOpsWorkItemSearchPage>(
      'azureBoards.search',
      { repo, wiql, limit }
    )
    printResult(response, context.json, formatAzureBoardsWorkItemList)
  },
  'azure-boards assigned': async (context) => {
    const repo = await resolveAzureBoardsRepo(context)
    const response = await context.client.call<AzureDevOpsAssignedWorkItemsPage>(
      'azureBoards.assigned',
      { repo }
    )
    printResult(response, context.json, formatAzureBoardsWorkItemList)
  },
  'azure-boards team list': async (context) => {
    const repo = await resolveAzureBoardsRepo(context)
    const response = await context.client.call<AzureDevOpsTeam[]>('azureBoards.teams', { repo })
    printResult(response, context.json, formatAzureBoardsTeams)
  }
}
