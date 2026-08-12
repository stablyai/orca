import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

const RepoSelector = z.object({
  // Repo id or path, resolved on the host that runs bd.
  repoId: requiredString('Missing repo id')
})

const IssuesList = RepoSelector.extend({
  preset: z.enum(['open', 'assigned', 'ready']).optional(),
  limit: OptionalFiniteNumber
})

const Issue = RepoSelector.extend({
  id: requiredString('Missing issue id')
})

const IssueStatusUpdate = Issue.extend({
  status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed'])
})

export const BEADS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'beads.getStatus',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.beadsGetStatus(params.repoId)
  }),
  defineMethod({
    name: 'beads.listIssues',
    params: IssuesList,
    handler: async (params, { runtime }) =>
      runtime.beadsListIssues(params.repoId, params.preset, params.limit)
  }),
  defineMethod({
    name: 'beads.getIssue',
    params: Issue,
    handler: async (params, { runtime }) => runtime.beadsGetIssue(params.repoId, params.id.trim())
  }),
  defineMethod({
    name: 'beads.updateIssue',
    params: IssueStatusUpdate,
    handler: async (params, { runtime }) =>
      runtime.beadsUpdateIssue(params.repoId, params.id.trim(), params.status)
  })
]
