import {
  AzureBoardsRepo,
  AzureBoardsSearch,
  AzureBoardsWorkItem,
  AzureBoardsWorkItemAssigneeSet,
  AzureBoardsWorkItemCommentAdd,
  AzureBoardsWorkItemComments,
  AzureBoardsWorkItemStateSet
} from '../../../../../../shared/rpc-contract/azure-boards/azure-boards-params'
import { defineMethod } from '../../../core'

// Reads are GETs or a WIQL POST; the three writes require `confirm: true` and spend a daily budget.
export const AZURE_BOARDS_METHODS = [
  defineMethod({
    name: 'azureBoards.connection',
    permission: 'workspace',
    params: AzureBoardsRepo,
    handler: async (params, { runtime }) => runtime.getAzureBoardsConnection(params.repo)
  }),
  defineMethod({
    name: 'azureBoards.workItem',
    permission: 'workspace',
    params: AzureBoardsWorkItem,
    handler: async (params, { runtime }) => runtime.getAzureBoardsWorkItem(params.repo, params.id)
  }),
  defineMethod({
    name: 'azureBoards.workItemComments',
    permission: 'workspace',
    params: AzureBoardsWorkItemComments,
    handler: async (params, { runtime }) =>
      runtime.listAzureBoardsWorkItemComments(params.repo, params.id, params.limit)
  }),
  defineMethod({
    name: 'azureBoards.search',
    permission: 'workspace',
    params: AzureBoardsSearch,
    handler: async (params, { runtime }) =>
      runtime.searchAzureBoardsWorkItems(params.repo, params.wiql, params.limit)
  }),
  defineMethod({
    name: 'azureBoards.assigned',
    permission: 'workspace',
    params: AzureBoardsRepo,
    handler: async (params, { runtime }) => runtime.listAzureBoardsAssignedWorkItems(params.repo)
  }),
  defineMethod({
    name: 'azureBoards.teams',
    permission: 'workspace',
    params: AzureBoardsRepo,
    handler: async (params, { runtime }) => runtime.listAzureBoardsTeams(params.repo)
  }),
  defineMethod({
    name: 'azureBoards.addComment',
    permission: 'workspace',
    params: AzureBoardsWorkItemCommentAdd,
    handler: async (params, { runtime }) =>
      runtime.addAzureBoardsWorkItemComment(params.repo, params.id, params.text)
  }),
  defineMethod({
    name: 'azureBoards.setState',
    permission: 'workspace',
    params: AzureBoardsWorkItemStateSet,
    handler: async (params, { runtime }) =>
      runtime.setAzureBoardsWorkItemState(params.repo, params.id, params.state, params.expectedRev)
  }),
  defineMethod({
    name: 'azureBoards.setAssignee',
    permission: 'workspace',
    params: AzureBoardsWorkItemAssigneeSet,
    handler: async (params, { runtime }) =>
      runtime.setAzureBoardsWorkItemAssignee(
        params.repo,
        params.id,
        params.assignee,
        params.expectedRev
      )
  })
]
