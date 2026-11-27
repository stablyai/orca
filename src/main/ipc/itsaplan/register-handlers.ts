import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import type { ZodType } from 'zod'
import type { ItsaplanFailure } from '../../../shared/itsaplan/itsaplan-types'
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
} from '../../../shared/rpc-contract/itsaplan/itsaplan-params'
import {
  itsaplanConnect,
  itsaplanDetectApiUrl,
  itsaplanDisconnect,
  itsaplanStatus,
  itsaplanTestConnection
} from '../../itsaplan/itsaplan-connection'
import { itsaplanGetIssue, itsaplanListIssues } from '../../itsaplan/itsaplan-issue-read'
import {
  itsaplanAddComment,
  itsaplanCreateIssue,
  itsaplanUpdateIssue
} from '../../itsaplan/itsaplan-issue-mutations'
import {
  itsaplanGetProjectMetadata,
  itsaplanListProjects
} from '../../itsaplan/itsaplan-project-queries'

const INVALID_ARGS: ItsaplanFailure = {
  ok: false,
  error: 'requestFailed',
  message: 'requestFailed: Invalid request arguments.'
}

// Read methods throw (renderer reads the code prefix); mutations return the failure.
function handleWithSchema<T, R>(
  ipc: IpcHandleRegistrar,
  channel: string,
  schema: ZodType<T>,
  onInvalid: 'throw' | 'failure',
  run: (args: T) => Promise<R>
): void {
  ipc.handle(channel, async (_event, raw: unknown) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      if (onInvalid === 'throw') {
        throw new Error(INVALID_ARGS.message)
      }
      return INVALID_ARGS
    }
    return run(parsed.data)
  })
}

export function registerItsaplanHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  handleWithSchema(ipc, 'itsaplan:detectApiUrl', DetectApiUrl, 'failure', itsaplanDetectApiUrl)
  handleWithSchema(ipc, 'itsaplan:connect', Connect, 'failure', itsaplanConnect)
  ipc.handle('itsaplan:disconnect', async () => itsaplanDisconnect())
  ipc.handle('itsaplan:status', async () => itsaplanStatus())
  ipc.handle('itsaplan:testConnection', async () => itsaplanTestConnection())
  handleWithSchema(ipc, 'itsaplan:listProjects', ListProjects, 'throw', itsaplanListProjects)
  handleWithSchema(
    ipc,
    'itsaplan:getProjectMetadata',
    ProjectRef,
    'throw',
    itsaplanGetProjectMetadata
  )
  handleWithSchema(ipc, 'itsaplan:listIssues', ListIssues, 'throw', itsaplanListIssues)
  handleWithSchema(ipc, 'itsaplan:getIssue', IssueId, 'throw', itsaplanGetIssue)
  handleWithSchema(ipc, 'itsaplan:createIssue', CreateIssue, 'failure', itsaplanCreateIssue)
  handleWithSchema(ipc, 'itsaplan:updateIssue', UpdateIssue, 'failure', itsaplanUpdateIssue)
  handleWithSchema(ipc, 'itsaplan:addComment', AddComment, 'failure', itsaplanAddComment)
}
