import { defineMethod } from '../core'
import {
  Connect,
  IssueId,
  ListIssues,
  SelectSite,
  SiteSelection
} from '../../../../shared/rpc-contract/mantisbt-params'

export const MANTISBT_METHODS = [
  defineMethod({
    name: 'mantisBT.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.mantisBTConnect({
        siteUrl: params.siteUrl.trim(),
        apiToken: params.apiToken.trim()
      })
  }),
  defineMethod({
    name: 'mantisBT.disconnect',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.mantisBTDisconnect(params?.siteId)
  }),
  defineMethod({
    name: 'mantisBT.selectSite',
    params: SelectSite,
    handler: async (params, { runtime }) => runtime.mantisBTSelectSite(params.siteId.trim())
  }),
  defineMethod({
    name: 'mantisBT.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.mantisBTStatus()
  }),
  defineMethod({
    name: 'mantisBT.testConnection',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.mantisBTTestConnection(params?.siteId)
  }),
  defineMethod({
    name: 'mantisBT.listIssues',
    params: ListIssues,
    handler: async (params, { runtime, signal }) =>
      runtime.mantisBTListIssues(
        params?.filter,
        params?.limit,
        params?.siteId,
        params?.projectId,
        signal
      )
  }),
  defineMethod({
    name: 'mantisBT.getIssue',
    params: IssueId,
    handler: async (params, { runtime, signal }) =>
      runtime.mantisBTGetIssue(params.id.trim(), params.siteId, signal)
  }),
  defineMethod({
    name: 'mantisBT.listProjects',
    params: SiteSelection,
    handler: async (params, { runtime, signal }) =>
      runtime.mantisBTListProjects(params?.siteId, signal)
  })
]
