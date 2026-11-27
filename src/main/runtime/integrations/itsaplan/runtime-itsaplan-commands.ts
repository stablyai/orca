import type {
  ItsaplanCreateIssueArgs,
  ItsaplanIssueListQuery,
  ItsaplanIssueUpdate
} from '../../../../shared/itsaplan/itsaplan-types'
import {
  itsaplanConnect,
  itsaplanDetectApiUrl,
  itsaplanDisconnect,
  itsaplanStatus,
  itsaplanTestConnection
} from '../../../itsaplan/itsaplan-connection'
import { itsaplanGetIssue, itsaplanListIssues } from '../../../itsaplan/itsaplan-issue-read'
import {
  itsaplanAddComment,
  itsaplanCreateIssue,
  itsaplanUpdateIssue
} from '../../../itsaplan/itsaplan-issue-mutations'
import {
  itsaplanGetProjectMetadata,
  itsaplanListProjects
} from '../../../itsaplan/itsaplan-project-queries'

export class RuntimeItsaplanCommands {
  itsaplanDetectApiUrl(args: { appUrl: string }) {
    return itsaplanDetectApiUrl(args)
  }

  itsaplanConnect(args: { appUrl: string; apiUrl?: string; apiKey: string }) {
    return itsaplanConnect(args)
  }

  async itsaplanDisconnect(): Promise<{ ok: true }> {
    await itsaplanDisconnect()
    return { ok: true }
  }

  itsaplanStatus() {
    return itsaplanStatus()
  }

  itsaplanTestConnection() {
    return itsaplanTestConnection()
  }

  itsaplanListProjects(args?: { query?: string }) {
    return itsaplanListProjects(args)
  }

  itsaplanGetProjectMetadata(args: { projectRef: string }) {
    return itsaplanGetProjectMetadata(args)
  }

  itsaplanListIssues(args: ItsaplanIssueListQuery) {
    return itsaplanListIssues(args)
  }

  itsaplanGetIssue(args: { issueId: number; projectRef?: string }) {
    return itsaplanGetIssue(args)
  }

  itsaplanCreateIssue(args: ItsaplanCreateIssueArgs) {
    return itsaplanCreateIssue(args)
  }

  itsaplanUpdateIssue(args: {
    issueId: number
    projectRef?: string
    updates: ItsaplanIssueUpdate
  }) {
    return itsaplanUpdateIssue(args)
  }

  itsaplanAddComment(args: { issueId: number; body: string }) {
    return itsaplanAddComment(args)
  }
}
