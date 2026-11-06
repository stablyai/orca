import { defineMethod } from '../../../core'
import {
  RepoSelector,
  RepoWithGitHubAccountExpectation
} from '../../../../../../shared/rpc-contract/github-repo-target-params'
import {
  IssuesList,
  RateLimit,
  WorkItem,
  WorkItemByOwnerRepo,
  WorkItemDetails,
  WorkItemsCount,
  WorkItemsList
} from '../../../../../../shared/rpc-contract/github-repo-work-item-params'

export const GITHUB_REPO_WORK_ITEM_METHODS = [
  defineMethod({
    name: 'github.repoSlug',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoSlug(params.repo)
  }),
  defineMethod({
    name: 'github.repoUpstream',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoUpstream(params.repo)
  }),
  defineMethod({
    name: 'github.rateLimit',
    permission: 'workspace',
    params: RateLimit,
    handler: async (params, { runtime }) => runtime.getGitHubRateLimit(params)
  }),
  defineMethod({
    name: 'github.listWorkItems',
    permission: 'workspace',
    params: WorkItemsList,
    handler: async (params, { runtime }) =>
      runtime.listRepoWorkItems(
        params.repo,
        params.limit,
        params.query,
        params.page,
        params.noCache
      )
  }),
  defineMethod({
    name: 'github.listIssues',
    permission: 'workspace',
    params: IssuesList,
    handler: async (params, { runtime }) => runtime.listRepoIssues(params.repo, params.limit)
  }),
  defineMethod({
    name: 'github.countWorkItems',
    permission: 'workspace',
    params: WorkItemsCount,
    handler: async (params, { runtime }) => runtime.countRepoWorkItems(params.repo, params.query)
  }),
  defineMethod({
    name: 'github.listLabels',
    permission: 'workspace',
    params: RepoWithGitHubAccountExpectation,
    handler: async (params, { runtime }) =>
      params.expectedGhAccount !== undefined
        ? runtime.listRepoLabels(params.repo, params.ownerRepo, params.expectedGhAccount)
        : runtime.listRepoLabels(
            params.repo,
            ...(params.ownerRepo ? ([params.ownerRepo] as const) : ([] as const))
          )
  }),
  defineMethod({
    name: 'github.listAssignableUsers',
    permission: 'workspace',
    params: RepoWithGitHubAccountExpectation,
    handler: async (params, { runtime }) =>
      params.expectedGhAccount !== undefined
        ? runtime.listRepoAssignableUsers(params.repo, params.ownerRepo, params.expectedGhAccount)
        : runtime.listRepoAssignableUsers(
            params.repo,
            ...(params.ownerRepo ? ([params.ownerRepo] as const) : ([] as const))
          )
  }),
  defineMethod({
    name: 'github.workItem',
    permission: 'workspace',
    params: WorkItem,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItem(params.repo, params.number, params.type)
  }),
  defineMethod({
    name: 'github.workItemByOwnerRepo',
    permission: 'workspace',
    params: WorkItemByOwnerRepo,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItemByOwnerRepo(
        params.repo,
        {
          owner: params.owner,
          repo: params.ownerRepo,
          ...(params.host ? { host: params.host } : {})
        },
        params.number,
        params.type,
        { preview: params.preview === true }
      )
  }),
  defineMethod({
    name: 'github.workItemDetails',
    permission: 'workspace',
    params: WorkItemDetails,
    handler: async (params, { runtime }) => {
      if (params.expectedGhAccount !== undefined) {
        return runtime.getRepoWorkItemDetails(
          params.repo,
          params.number,
          params.type,
          params.ownerRepo,
          params.canonical,
          params.expectedGhAccount
        )
      }
      if (params.canonical !== undefined) {
        return runtime.getRepoWorkItemDetails(
          params.repo,
          params.number,
          params.type,
          params.ownerRepo,
          params.canonical
        )
      }
      if (params.ownerRepo) {
        return runtime.getRepoWorkItemDetails(
          params.repo,
          params.number,
          params.type,
          params.ownerRepo
        )
      }
      return runtime.getRepoWorkItemDetails(params.repo, params.number, params.type)
    }
  })
]
