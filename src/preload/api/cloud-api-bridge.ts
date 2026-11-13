import { ipcRenderer } from 'electron'
import type {
  CloudApiApproval,
  CloudApiAvailability,
  CloudApiCreatedKey,
  CloudApiGrant,
  CloudApiInstallation,
  CloudApiKeyList,
  CloudApiMe,
  CloudApiProject,
  CloudApiResult,
  CloudApiSettings,
  CloudAuditLogExport,
  CloudAuditLogPage,
  CloudAuditLogQuery,
  CreateCloudApiApprovalInput,
  CreateCloudApiKeyInput,
  Routine,
  RoutineCreated,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RoutineRunPage,
  RoutineRunsQuery,
  RoutineUpdated
} from '../../shared/cloud-api/cloud-api-types'

/** Desktop only: Orca Cloud API keys, org settings, the team audit log and routines. The session token stays in main. */
export type CloudApiBridge = {
  availability: () => Promise<CloudApiAvailability>
  /** The desktop workspace running on this Orca Cloud sandbox, if this computer has it. */
  localWorkspaceFor: (sandboxId: string) => Promise<string | null>
  me: () => Promise<CloudApiResult<CloudApiMe>>
  listApiKeys: () => Promise<CloudApiResult<CloudApiKeyList>>
  createApiKey: (input: CreateCloudApiKeyInput) => Promise<CloudApiResult<CloudApiCreatedKey>>
  revokeApiKey: (id: string) => Promise<CloudApiResult<unknown>>
  createApproval: (input?: CreateCloudApiApprovalInput) => Promise<CloudApiResult<CloudApiApproval>>
  listGrants: () => Promise<CloudApiResult<{ grants: CloudApiGrant[] }>>
  revokeGrant: (id: string) => Promise<CloudApiResult<unknown>>
  getSettings: () => Promise<CloudApiResult<CloudApiSettings>>
  putSettings: (input: { vmCliEnabled: boolean }) => Promise<CloudApiResult<CloudApiSettings>>
  /** The team audit log: owners and admins of a team whose plan includes it (else `plan-required`). */
  listAuditLog: (query?: CloudAuditLogQuery) => Promise<CloudApiResult<CloudAuditLogPage>>
  exportAuditLogCsv: (
    query?: Pick<CloudAuditLogQuery, 'category' | 'actor'>
  ) => Promise<CloudApiResult<CloudAuditLogExport>>
  listProjects: () => Promise<CloudApiResult<{ projects: CloudApiProject[] }>>
  listInstallations: () => Promise<CloudApiResult<{ installations: CloudApiInstallation[] }>>
  listRoutines: () => Promise<CloudApiResult<{ routines: Routine[] }>>
  createRoutine: (input: RoutineInput) => Promise<CloudApiResult<RoutineCreated>>
  updateRoutine: (id: string, patch: RoutinePatch) => Promise<CloudApiResult<RoutineUpdated>>
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
  localWorkspaceFor: invoke('cloudApi:localWorkspaceFor'),
  me: invoke('cloudApi:me'),
  listApiKeys: invoke('cloudApi:listApiKeys'),
  createApiKey: invoke('cloudApi:createApiKey'),
  revokeApiKey: invoke('cloudApi:revokeApiKey'),
  createApproval: invoke('cloudApi:createApproval'),
  listGrants: invoke('cloudApi:listGrants'),
  revokeGrant: invoke('cloudApi:revokeGrant'),
  getSettings: invoke('cloudApi:getSettings'),
  putSettings: invoke('cloudApi:putSettings'),
  listAuditLog: invoke('cloudApi:listAuditLog'),
  exportAuditLogCsv: invoke('cloudApi:exportAuditLogCsv'),
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
