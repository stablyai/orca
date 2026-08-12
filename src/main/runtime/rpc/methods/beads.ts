import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

const RepoSelector = z.object({
  // Repo id or path, resolved on the host that runs bd.
  repoId: requiredString('Missing repo id')
})

const IssuesList = RepoSelector.extend({
  preset: z.enum(['open', 'assigned', 'ready']).optional(),
  limit: OptionalFiniteNumber,
  // beads-query-filter.v1: explicit fetch scope; 'all' includes closed issues.
  statusScope: z.enum(['open', 'all', 'ready']).optional(),
  // '@me' resolves to the repo host's actor.
  assignee: z.string().optional()
})

const Issue = RepoSelector.extend({
  id: requiredString('Missing issue id')
})

const IssueStatusUpdate = Issue.extend({
  status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed'])
})

const IssueComment = Issue.extend({
  text: requiredString('Missing comment text')
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
      runtime.beadsListIssues(params.repoId, params.preset, params.limit, {
        ...(params.statusScope !== undefined ? { statusScope: params.statusScope } : {}),
        ...(params.assignee !== undefined ? { assignee: params.assignee } : {})
      })
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
  }),
  defineMethod({
    name: 'beads.getIssueDetails',
    params: Issue,
    handler: async (params, { runtime }) =>
      runtime.beadsGetIssueDetails(params.repoId, params.id.trim())
  }),
  defineMethod({
    name: 'beads.addComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.beadsAddComment(params.repoId, params.id.trim(), params.text)
  })
]
