import { ipcMain } from 'electron'
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
  channel: string,
  schema: ZodType<T>,
  onInvalid: 'throw' | 'failure',
  run: (args: T) => Promise<R>
): void {
  ipcMain.handle(channel, async (_event, raw: unknown) => {
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

export function registerItsaplanHandlers(): void {
  handleWithSchema('itsaplan:detectApiUrl', DetectApiUrl, 'failure', itsaplanDetectApiUrl)
  handleWithSchema('itsaplan:connect', Connect, 'failure', itsaplanConnect)
  ipcMain.handle('itsaplan:disconnect', async () => itsaplanDisconnect())
  ipcMain.handle('itsaplan:status', async () => itsaplanStatus())
  ipcMain.handle('itsaplan:testConnection', async () => itsaplanTestConnection())
  handleWithSchema('itsaplan:listProjects', ListProjects, 'throw', itsaplanListProjects)
  handleWithSchema('itsaplan:getProjectMetadata', ProjectRef, 'throw', itsaplanGetProjectMetadata)
  handleWithSchema('itsaplan:listIssues', ListIssues, 'throw', itsaplanListIssues)
  handleWithSchema('itsaplan:getIssue', IssueId, 'throw', itsaplanGetIssue)
  handleWithSchema('itsaplan:createIssue', CreateIssue, 'failure', itsaplanCreateIssue)
  handleWithSchema('itsaplan:updateIssue', UpdateIssue, 'failure', itsaplanUpdateIssue)
  handleWithSchema('itsaplan:addComment', AddComment, 'failure', itsaplanAddComment)
}
