import { AzureBoardsRepo } from '../../../../../../shared/rpc-contract/azure-boards/azure-boards-params'
import {
  AzureDevOpsPr,
  AzureDevOpsPrBranch,
  AzureDevOpsPrBuild,
  AzureDevOpsPrComment,
  AzureDevOpsPrFiles,
  AzureDevOpsPrVote
} from '../../../../../../shared/rpc-contract/azure-boards/azure-devops-pr-review-params'
import { defineMethod } from '../../../core'

// Reads are GETs; the two writes require `confirm: true` and spend a daily budget.
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
  }),
  defineMethod({
    name: 'azureDevOps.prBuild',
    permission: 'workspace',
    params: AzureDevOpsPrBuild,
    handler: async (params, { runtime }) =>
      runtime.getAzureDevOpsPrBuild(params.repo, params.id, params.buildId, {
        logs: params.logs,
        tail: params.tail
      })
  }),
  defineMethod({
    name: 'azureDevOps.prComment',
    permission: 'workspace',
    params: AzureDevOpsPrComment,
    handler: async (params, { runtime }) =>
      runtime.addAzureDevOpsPrComment(params.repo, params.id, {
        body: params.body,
        threadId: params.threadId,
        filePath: params.filePath,
        line: params.line
      })
  }),
  defineMethod({
    name: 'azureDevOps.prVote',
    permission: 'workspace',
    params: AzureDevOpsPrVote,
    handler: async (params, { runtime }) =>
      runtime.setAzureDevOpsPrVote(params.repo, params.id, params.vote)
  })
]
