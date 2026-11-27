import { defineMethod } from '../../../core'
import {
  AddComment,
  Connect,
  CreateIssue,
  DetectApiUrl,
  IssueId,
  ListIssues,
  ListProjects,
  ProjectRef,
  UpdateIssue
} from '../../../../../../shared/rpc-contract/itsaplan/itsaplan-params'

export const ITSAPLAN_METHODS = [
  defineMethod({
    name: 'itsaplan.detectApiUrl',
    permission: 'workspace',
    params: DetectApiUrl,
    handler: async (params, { runtime }) => runtime.itsaplanDetectApiUrl(params)
  }),
  defineMethod({
    name: 'itsaplan.connect',
    permission: 'accounts-admin',
    params: Connect,
    handler: async (params, { runtime }) => runtime.itsaplanConnect(params)
  }),
  defineMethod({
    name: 'itsaplan.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, { runtime }) => runtime.itsaplanDisconnect()
  }),
  defineMethod({
    name: 'itsaplan.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.itsaplanStatus()
  }),
  defineMethod({
    name: 'itsaplan.testConnection',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.itsaplanTestConnection()
  }),
  defineMethod({
    name: 'itsaplan.listProjects',
    permission: 'workspace',
    params: ListProjects,
    handler: async (params, { runtime }) => runtime.itsaplanListProjects(params)
  }),
  defineMethod({
    name: 'itsaplan.getProjectMetadata',
    permission: 'workspace',
    params: ProjectRef,
    handler: async (params, { runtime }) => runtime.itsaplanGetProjectMetadata(params)
  }),
  defineMethod({
    name: 'itsaplan.listIssues',
    permission: 'workspace',
    params: ListIssues,
    handler: async (params, { runtime }) => runtime.itsaplanListIssues(params)
  }),
  defineMethod({
    name: 'itsaplan.getIssue',
    permission: 'workspace',
    params: IssueId,
    handler: async (params, { runtime }) => runtime.itsaplanGetIssue(params)
  }),
  defineMethod({
    name: 'itsaplan.createIssue',
    permission: 'workspace',
    params: CreateIssue,
    handler: async (params, { runtime }) => runtime.itsaplanCreateIssue(params)
  }),
  defineMethod({
    name: 'itsaplan.updateIssue',
    permission: 'workspace',
    params: UpdateIssue,
    handler: async (params, { runtime }) => runtime.itsaplanUpdateIssue(params)
  }),
  defineMethod({
    name: 'itsaplan.addComment',
    permission: 'workspace',
    params: AddComment,
    handler: async (params, { runtime }) => runtime.itsaplanAddComment(params)
  })
]
