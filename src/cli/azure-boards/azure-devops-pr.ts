import {
  AZURE_DEVOPS_PR_REVIEW_READ_RUNTIME_CAPABILITY,
  type AzureDevOpsPrBuild,
  type AzureDevOpsPrCheck,
  type AzureDevOpsPrDetail,
  type AzureDevOpsPrFiles,
  type AzureDevOpsPrSummary,
  type AzureDevOpsPrThread
} from '../../shared/azure-devops/azure-devops-pr-review-types'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  formatAzureDevOpsPr,
  formatAzureDevOpsPrBuild,
  formatAzureDevOpsPrChecks,
  formatAzureDevOpsPrFiles,
  formatAzureDevOpsPrList,
  formatAzureDevOpsPrThreads
} from './azure-devops-pr-format'
import { resolveAzureBoardsRepo } from './azure-boards-target'
import { azureDevOpsPrWriteHandlers } from './azure-devops-pr-write'

function prTarget(context: HandlerContext): Promise<string> {
  return resolveAzureBoardsRepo(context, AZURE_DEVOPS_PR_REVIEW_READ_RUNTIME_CAPABILITY)
}

function prId(context: HandlerContext): number {
  const raw = getRequiredStringFlag(context.flags, 'id').trim().replace(/^[#!]/, '')
  const id = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new RuntimeClientError('invalid_argument', 'Expected a numeric pull request id.')
  }
  return id
}

function sinceIteration(context: HandlerContext): number | undefined {
  const raw = getOptionalStringFlag(context.flags, 'since-iteration')?.trim()
  if (raw === undefined) {
    return undefined
  }
  if (!/^\d+$/.test(raw)) {
    throw new RuntimeClientError('invalid_argument', '--since-iteration must be 0 or more.')
  }
  return Number(raw)
}

export const AZURE_DEVOPS_PR_HANDLERS: Record<string, CommandHandler> = {
  ...azureDevOpsPrWriteHandlers(prId),
  'azure-devops pr list': async (context) => {
    const branch = getOptionalStringFlag(context.flags, 'branch')?.trim()
    const repo = await prTarget(context)
    const response = branch
      ? await context.client.call<AzureDevOpsPrSummary[]>('azureDevOps.prForBranch', {
          repo,
          branch
        })
      : await context.client.call<AzureDevOpsPrSummary[]>('azureDevOps.prAwaitingReview', {
          repo
        })
    printResult(response, context.json, formatAzureDevOpsPrList)
  },
  'azure-devops pr show': async (context) => {
    const id = prId(context)
    const repo = await prTarget(context)
    const response = await context.client.call<AzureDevOpsPrDetail | null>('azureDevOps.pr', {
      repo,
      id
    })
    printResult(response, context.json, formatAzureDevOpsPr)
  },
  'azure-devops pr threads': async (context) => {
    const id = prId(context)
    const repo = await prTarget(context)
    const response = await context.client.call<AzureDevOpsPrThread[]>('azureDevOps.prThreads', {
      repo,
      id
    })
    printResult(response, context.json, formatAzureDevOpsPrThreads)
  },
  'azure-devops pr checks': async (context) => {
    const id = prId(context)
    const repo = await prTarget(context)
    const response = await context.client.call<AzureDevOpsPrCheck[]>('azureDevOps.prChecks', {
      repo,
      id
    })
    printResult(response, context.json, formatAzureDevOpsPrChecks)
  },
  'azure-devops pr files': async (context) => {
    const id = prId(context)
    const since = sinceIteration(context)
    const repo = await prTarget(context)
    const response = await context.client.call<AzureDevOpsPrFiles>('azureDevOps.prFiles', {
      repo,
      id,
      ...(since !== undefined ? { sinceIteration: since } : {})
    })
    printResult(response, context.json, formatAzureDevOpsPrFiles)
  },
  'azure-devops pr build': async (context) => {
    const id = prId(context)
    const buildId = getOptionalPositiveIntegerFlag(context.flags, 'build')
    if (buildId === undefined) {
      throw new RuntimeClientError('invalid_argument', 'Pass --build <buildId> from `pr checks`.')
    }
    const tail = getOptionalPositiveIntegerFlag(context.flags, 'tail')
    const repo = await prTarget(context)
    const response = await context.client.call<AzureDevOpsPrBuild>('azureDevOps.prBuild', {
      repo,
      id,
      buildId,
      logs: context.flags.get('log') === true,
      ...(tail !== undefined ? { tail: Math.min(tail, 1000) } : {})
    })
    printResult(response, context.json, formatAzureDevOpsPrBuild)
  }
}
