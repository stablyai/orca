import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { IssueUpdate } from './github-issue-update-schema'
import { RepoSelector, SlugRepo } from './github-repo-target-schemas'

const Issue = RepoSelector.extend({
  number: z.number().int().positive()
})

const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional()
})

const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate
})

const IssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body required'),
  type: z.enum(['issue', 'pr']).optional(),
  prRepo: SlugRepo.nullable().optional()
})

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
