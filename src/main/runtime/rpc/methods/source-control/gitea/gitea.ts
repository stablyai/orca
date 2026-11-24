import { defineMethod } from '../../../core'
import {
  connect,
  disconnect,
  getStatus,
  selectServer,
  testConnection
} from '../../../../../gitea/servers/gitea-server-connection'
import {
  GiteaAddIssueComment,
  GiteaAddPullRequestReviewComment,
  GiteaConnectParams,
  GiteaCreateIssue,
  GiteaIssueByNumber,
  GiteaMergePullRequest,
  GiteaPullRequestChecks,
  GiteaPullRequestFileContents,
  GiteaRepoSelector,
  GiteaSelectServerParams,
  GiteaServerIdParams,
  GiteaUpdateIssue,
  GiteaWorkItemsList
} from '../../../../../../shared/rpc-contract/source-control/gitea-params'

export const GITEA_METHODS = [
  defineMethod({
    name: 'gitea.status',
    permission: 'workspace',
    params: null,
    handler: async () => getStatus()
  }),
  defineMethod({
    name: 'gitea.connect',
    permission: 'accounts-admin',
    params: GiteaConnectParams,
    handler: async (params) => connect(params)
  }),
  defineMethod({
    name: 'gitea.disconnect',
    permission: 'accounts-admin',
    params: GiteaServerIdParams,
    handler: async (params) => disconnect(params.serverId)
  }),
  defineMethod({
    name: 'gitea.selectServer',
    permission: 'workspace',
    params: GiteaSelectServerParams,
    handler: async (params) => selectServer(params.serverId)
  }),
  defineMethod({
    name: 'gitea.testConnection',
    permission: 'workspace',
    params: GiteaServerIdParams,
    handler: async (params) => testConnection(params.serverId)
  }),
  defineMethod({
    name: 'gitea.listWorkItems',
    permission: 'workspace',
    params: GiteaWorkItemsList,
    handler: async (params, { runtime }) => runtime.listGiteaRepoWorkItems(params)
  }),
  defineMethod({
    name: 'gitea.issue',
    permission: 'workspace',
    params: GiteaIssueByNumber,
    handler: async (params, { runtime }) => runtime.getGiteaRepoIssue(params)
  }),
  defineMethod({
    name: 'gitea.issueComments',
    permission: 'workspace',
    params: GiteaIssueByNumber,
    handler: async (params, { runtime }) => runtime.listGiteaRepoIssueComments(params)
  }),
  defineMethod({
    name: 'gitea.labels',
    permission: 'workspace',
    params: GiteaRepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'gitea.assignees',
    permission: 'workspace',
    params: GiteaRepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoAssignees(params.repo)
  }),
  defineMethod({
    name: 'gitea.createIssue',
    permission: 'workspace',
    params: GiteaCreateIssue,
    handler: async (params, { runtime }) => runtime.createGiteaRepoIssue(params)
  }),
  defineMethod({
    name: 'gitea.updateIssue',
    permission: 'workspace',
    params: GiteaUpdateIssue,
    handler: async (params, { runtime }) => runtime.updateGiteaRepoIssue(params)
  }),
  defineMethod({
    name: 'gitea.addIssueComment',
    permission: 'workspace',
    params: GiteaAddIssueComment,
    handler: async (params, { runtime }) => runtime.addGiteaRepoIssueComment(params)
  }),
  defineMethod({
    name: 'gitea.prDetail',
    permission: 'workspace',
    params: GiteaIssueByNumber,
    handler: async (params, { runtime }) => runtime.getGiteaRepoPullRequestDetail(params)
  }),
  defineMethod({
    name: 'gitea.prFiles',
    permission: 'workspace',
    params: GiteaIssueByNumber,
    handler: async (params, { runtime }) => runtime.listGiteaRepoPullRequestFiles(params)
  }),
  defineMethod({
    name: 'gitea.prFileContents',
    permission: 'workspace',
    params: GiteaPullRequestFileContents,
    handler: async (params, { runtime }) => runtime.getGiteaRepoPullRequestFileContents(params)
  }),
  defineMethod({
    name: 'gitea.prChecks',
    permission: 'workspace',
    params: GiteaPullRequestChecks,
    handler: async (params, { runtime }) => runtime.getGiteaRepoPullRequestChecks(params)
  }),
  defineMethod({
    name: 'gitea.prMerge',
    permission: 'workspace',
    params: GiteaMergePullRequest,
    handler: async (params, { runtime }) => runtime.mergeGiteaRepoPullRequest(params)
  }),
  defineMethod({
    name: 'gitea.prReviewComments',
    permission: 'workspace',
    params: GiteaIssueByNumber,
    handler: async (params, { runtime }) => runtime.listGiteaRepoPullRequestReviewComments(params)
  }),
  defineMethod({
    name: 'gitea.prAddReviewComment',
    permission: 'workspace',
    params: GiteaAddPullRequestReviewComment,
    handler: async (params, { runtime }) => runtime.addGiteaRepoPullRequestReviewComment(params)
  })
]
