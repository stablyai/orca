import {
  AzureBoardsRepo,
  AzureBoardsSearch,
  AzureBoardsWorkItem,
  AzureBoardsWorkItemComments
} from '../../../../../../shared/rpc-contract/azure-boards/azure-boards-params'
import { defineMethod } from '../../../core'

// Read-only: every method is a GET or a WIQL POST, which Azure DevOps treats as a read.
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
  })
]
