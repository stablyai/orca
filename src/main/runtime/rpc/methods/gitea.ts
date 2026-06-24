/* Gitea/Forgejo RPC methods — mirrors methods/gitlab.ts footprint for
   the issue operations. No MR/PR methods here (handled by the existing
   gitea PR preflight path). */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

const IssuesList = RepoSelector.extend({
  state: z.enum(['open', 'closed', 'all']).optional(),
  assignee: OptionalString,
  limit: OptionalFiniteNumber
})

const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: z.string()
})

const IssueUpdate = z.object({
  state: z.enum(['open', 'closed']).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional()
})

const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate
})

const AddIssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body is required')
})

export const GITEA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'gitea.authStatus',
    params: z.object({}).optional().default({}),
    handler: async (_params, { runtime }) => runtime.giteaAuthStatus()
  }),
  defineMethod({
    name: 'gitea.issue',
    params: RepoSelector.extend({ number: z.number().int().positive() }),
    handler: async (params, { runtime }) => runtime.getGiteaRepoIssue(params.repo, params.number)
  }),
  defineMethod({
    name: 'gitea.listIssues',
    params: IssuesList,
    handler: async (params, { runtime }) =>
      runtime.listGiteaRepoIssues(params.repo, params.state, params.assignee, params.limit)
  }),
  defineMethod({
    name: 'gitea.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.createGiteaRepoIssue(params.repo, params.title, params.body)
  }),
  defineMethod({
    name: 'gitea.updateIssue',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateGiteaRepoIssue(params.repo, params.number, params.updates)
  }),
  defineMethod({
    name: 'gitea.addIssueComment',
    params: AddIssueComment,
    handler: async (params, { runtime }) =>
      runtime.addGiteaRepoIssueComment(params.repo, params.number, params.body)
  }),
  defineMethod({
    name: 'gitea.listLabels',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'gitea.listAssignableUsers',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoAssignableUsers(params.repo)
  })
]
