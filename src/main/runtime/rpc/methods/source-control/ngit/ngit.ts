import { defineMethod } from '../../../core'
import {
  NgitCommentAdd,
  NgitIssueCreate,
  NgitRepoSelector,
  NgitStatusChange,
  NgitWorkItemSelector,
  NgitWorkItemsList
} from '../../../../../../shared/rpc-contract/source-control/ngit-params'

export const NGIT_METHODS = [
  defineMethod({
    name: 'ngit.listWorkItems',
    permission: 'workspace',
    params: NgitWorkItemsList,
    handler: async (params, { runtime }) => runtime.ngit.listWorkItems(params.repo, params.force)
  }),
  defineMethod({
    name: 'ngit.workItemDetails',
    permission: 'workspace',
    params: NgitWorkItemSelector,
    handler: async (params, { runtime }) =>
      runtime.ngit.getWorkItemDetails(params.repo, params.eventId, params.force)
  }),
  defineMethod({
    name: 'ngit.createIssue',
    permission: 'workspace',
    params: NgitIssueCreate,
    handler: async (params, { runtime }) =>
      runtime.ngit.createIssue(params.repo, params.title, params.body)
  }),
  defineMethod({
    name: 'ngit.addComment',
    permission: 'workspace',
    params: NgitCommentAdd,
    handler: async (params, { runtime }) =>
      runtime.ngit.addComment(params.repo, params.type, params.eventId, params.body)
  }),
  defineMethod({
    name: 'ngit.setStatus',
    permission: 'workspace',
    params: NgitStatusChange,
    handler: async (params, { runtime }) =>
      runtime.ngit.setStatus(params.repo, params.type, params.eventId, params.action)
  }),
  defineMethod({
    name: 'ngit.mergePr',
    permission: 'workspace',
    params: NgitWorkItemSelector,
    handler: async (params, { runtime }) =>
      runtime.ngit.mergePullRequest(params.repo, params.eventId)
  }),
  defineMethod({
    name: 'ngit.resolvePrBase',
    permission: 'workspace',
    params: NgitWorkItemSelector,
    handler: async (params, { runtime }) =>
      runtime.ngit.resolvePullRequestBase(params.repo, params.eventId)
  }),
  defineMethod({
    name: 'ngit.viewer',
    permission: 'workspace',
    params: NgitRepoSelector,
    handler: async (params, { runtime }) => runtime.ngit.getViewer(params.repo)
  })
]
