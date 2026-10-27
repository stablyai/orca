import { defineMethod } from '../core'
import {
  CreateIssue,
  Issue,
  IssueComment,
  UpdateIssue
} from '../../../../shared/rpc-contract/github-issue-params'

export const GITHUB_ISSUE_METHODS = [
  defineMethod({
    name: 'github.issue',
    permission: 'workspace',
    params: Issue,
    handler: async (params, { runtime }) => runtime.getRepoIssue(params.repo, params.number)
  }),
  defineMethod({
    name: 'github.createIssue',
    permission: 'workspace',
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
    permission: 'workspace',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateRepoIssue(params.repo, params.number, params.updates)
  }),
  defineMethod({
    name: 'github.addIssueComment',
    permission: 'workspace',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      params.type
        ? runtime.addRepoIssueComment(
            params.repo,
            params.number,
            params.body,
            params.prRepo ?? null,
            params.type
          )
        : runtime.addRepoIssueComment(
            params.repo,
            params.number,
            params.body,
            params.prRepo ?? null
          )
  })
]
