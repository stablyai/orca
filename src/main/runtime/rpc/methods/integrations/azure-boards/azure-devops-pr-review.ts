import { AzureBoardsRepo } from '../../../../../../shared/rpc-contract/azure-boards/azure-boards-params'
import {
  AzureDevOpsPr,
  AzureDevOpsPrBranch,
  AzureDevOpsPrFiles
} from '../../../../../../shared/rpc-contract/azure-boards/azure-devops-pr-review-params'
import { defineMethod } from '../../../core'

// Read-only: GETs only. Voting and commenting are separate, confirmed writes.
export const AZURE_DEVOPS_PR_REVIEW_METHODS = [
  defineMethod({
    name: 'azureDevOps.prAwaitingReview',
    permission: 'workspace',
    params: AzureBoardsRepo,
    handler: async (params, { runtime }) => runtime.listAzureDevOpsPrsAwaitingReview(params.repo)
  }),
  defineMethod({
    name: 'azureDevOps.prForBranch',
    permission: 'workspace',
    params: AzureDevOpsPrBranch,
    handler: async (params, { runtime }) =>
      runtime.listAzureDevOpsPrsForBranch(params.repo, params.branch)
  }),
  defineMethod({
    name: 'azureDevOps.pr',
    permission: 'workspace',
    params: AzureDevOpsPr,
    handler: async (params, { runtime }) => runtime.getAzureDevOpsPr(params.repo, params.id)
  }),
  defineMethod({
    name: 'azureDevOps.prThreads',
    permission: 'workspace',
    params: AzureDevOpsPr,
    handler: async (params, { runtime }) => runtime.listAzureDevOpsPrThreads(params.repo, params.id)
  }),
  defineMethod({
    name: 'azureDevOps.prChecks',
    permission: 'workspace',
    params: AzureDevOpsPr,
    handler: async (params, { runtime }) => runtime.listAzureDevOpsPrChecks(params.repo, params.id)
  }),
  defineMethod({
    name: 'azureDevOps.prFiles',
    permission: 'workspace',
    params: AzureDevOpsPrFiles,
    handler: async (params, { runtime }) =>
      runtime.listAzureDevOpsPrFiles(params.repo, params.id, params.sinceIteration)
  })
]
