import { defineMethod } from '../core'
import { RepoSelector } from './github-repo-target-schemas'
import {
  IssuesList,
  RateLimit,
  WorkItem,
  WorkItemByOwnerRepo,
  WorkItemDetails,
  WorkItemsCount,
  WorkItemsList
} from '../../../../shared/rpc-contract/github-repo-work-item-params'

export const GITHUB_REPO_WORK_ITEM_METHODS = [
  defineMethod({
    name: 'github.repoSlug',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoSlug(params.repo)
  }),
  defineMethod({
    name: 'github.repoUpstream',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoUpstream(params.repo)
  }),
  defineMethod({
    name: 'github.rateLimit',
    params: RateLimit,
    handler: async (params, { runtime }) => runtime.getGitHubRateLimit(params)
  }),
  defineMethod({
    name: 'github.listWorkItems',
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
    params: IssuesList,
    handler: async (params, { runtime }) => runtime.listRepoIssues(params.repo, params.limit)
  }),
  defineMethod({
    name: 'github.countWorkItems',
    params: WorkItemsCount,
    handler: async (params, { runtime }) => runtime.countRepoWorkItems(params.repo, params.query)
  }),
  defineMethod({
    name: 'github.listLabels',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'github.listAssignableUsers',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listRepoAssignableUsers(params.repo)
  }),
  defineMethod({
    name: 'github.workItem',
    params: WorkItem,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItem(params.repo, params.number, params.type)
  }),
  defineMethod({
    name: 'github.workItemByOwnerRepo',
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
        params.type
      )
  }),
  defineMethod({
    name: 'github.workItemDetails',
    params: WorkItemDetails,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItemDetails(params.repo, params.number, params.type)
  })
]
