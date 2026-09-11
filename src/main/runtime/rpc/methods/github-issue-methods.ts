import { defineMethod, type RpcMethod } from '../core'
import {
  CreateIssue,
  Issue,
  IssueComment,
  UpdateIssue
} from '../../../../shared/rpc-contract/github-issue-params'

export const GITHUB_ISSUE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'github.issue',
    params: Issue,
    handler: async (params, { runtime }) => runtime.getRepoIssue(params.repo, params.number)
  }),
  defineMethod({
    name: 'github.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) => {
      const fields =
        params.labels !== undefined || params.assignees !== undefined
          ? { labels: params.labels, assignees: params.assignees }
          : undefined
      return fields
        ? runtime.createRepoIssue(params.repo, params.title, params.body, fields)
        : runtime.createRepoIssue(params.repo, params.title, params.body)
    }
  }),
  defineMethod({
    name: 'github.updateIssue',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateRepoIssue(params.repo, params.number, params.updates)
  }),
  defineMethod({
    name: 'github.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.addRepoIssueComment(params.repo, params.number, params.body, params.prRepo ?? null)
  })
]
