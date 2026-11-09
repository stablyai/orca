import { ipcRenderer } from 'electron'
import type {
  CloudApiApproval,
  CloudApiAuditPage,
  CloudApiAvailability,
  CloudApiCreatedKey,
  CloudApiGrant,
  CloudApiInstallation,
  CloudApiKeyList,
  CloudApiMe,
  CloudApiProject,
  CloudApiResult,
  CloudApiSettings,
  CreateCloudApiApprovalInput,
  CreateCloudApiKeyInput,
  Routine,
  RoutineCreated,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RoutineRunPage,
  RoutineRunsQuery
} from '../../shared/cloud-api/cloud-api-types'

/** Desktop only: Orca Cloud API keys, org settings, audit and routines. The session token stays in main. */
export type CloudApiBridge = {
  availability: () => Promise<CloudApiAvailability>
  me: () => Promise<CloudApiResult<CloudApiMe>>
  listApiKeys: () => Promise<CloudApiResult<CloudApiKeyList>>
  createApiKey: (input: CreateCloudApiKeyInput) => Promise<CloudApiResult<CloudApiCreatedKey>>
  revokeApiKey: (id: string) => Promise<CloudApiResult<unknown>>
  createApproval: (input?: CreateCloudApiApprovalInput) => Promise<CloudApiResult<CloudApiApproval>>
  listGrants: () => Promise<CloudApiResult<{ grants: CloudApiGrant[] }>>
  revokeGrant: (id: string) => Promise<CloudApiResult<unknown>>
  getSettings: () => Promise<CloudApiResult<CloudApiSettings>>
  putSettings: (input: { vmCliEnabled: boolean }) => Promise<CloudApiResult<CloudApiSettings>>
  listAudit: (query?: {
    limit?: number
    before?: number
  }) => Promise<CloudApiResult<CloudApiAuditPage>>
  listProjects: () => Promise<CloudApiResult<{ projects: CloudApiProject[] }>>
  listInstallations: () => Promise<CloudApiResult<{ installations: CloudApiInstallation[] }>>
  listRoutines: () => Promise<CloudApiResult<{ routines: Routine[] }>>
  createRoutine: (input: RoutineInput) => Promise<CloudApiResult<RoutineCreated>>
  updateRoutine: (id: string, patch: RoutinePatch) => Promise<CloudApiResult<{ routine: Routine }>>
  deleteRoutine: (id: string) => Promise<CloudApiResult<unknown>>
  runRoutine: (id: string) => Promise<CloudApiResult<{ run: RoutineRun }>>
  rotateRoutineWebhook: (id: string) => Promise<CloudApiResult<{ url: string }>>
  listRoutineRuns: (id: string, query?: RoutineRunsQuery) => Promise<CloudApiResult<RoutineRunPage>>
}

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

export const cloudApiBridge: CloudApiBridge = {
  availability: invoke('cloudApi:availability'),
  me: invoke('cloudApi:me'),
  listApiKeys: invoke('cloudApi:listApiKeys'),
  createApiKey: invoke('cloudApi:createApiKey'),
  revokeApiKey: invoke('cloudApi:revokeApiKey'),
  createApproval: invoke('cloudApi:createApproval'),
  listGrants: invoke('cloudApi:listGrants'),
  revokeGrant: invoke('cloudApi:revokeGrant'),
  getSettings: invoke('cloudApi:getSettings'),
  putSettings: invoke('cloudApi:putSettings'),
  listAudit: invoke('cloudApi:listAudit'),
  listProjects: invoke('cloudApi:listProjects'),
  listInstallations: invoke('cloudApi:listInstallations'),
  listRoutines: invoke('cloudApi:listRoutines'),
  createRoutine: invoke('cloudApi:createRoutine'),
  updateRoutine: invoke('cloudApi:updateRoutine'),
  deleteRoutine: invoke('cloudApi:deleteRoutine'),
  runRoutine: invoke('cloudApi:runRoutine'),
  rotateRoutineWebhook: invoke('cloudApi:rotateRoutineWebhook'),
  listRoutineRuns: invoke('cloudApi:listRoutineRuns')
}
