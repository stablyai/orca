import type {
  MantisBTConnectArgs,
  MantisBTConnectionStatus,
  MantisBTIssue,
  MantisBTIssueFilter,
  MantisBTProject,
  MantisBTSiteSelection,
  MantisBTViewer
} from '../../shared/mantisbt-types'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../mantisbt/client'
import { getIssue, listIssues, listProjects } from '../mantisbt/issues'

type MantisBTConnectResult = { ok: true; viewer: MantisBTViewer } | { ok: false; error: string }

export class RuntimeMantisBTCommands {
  mantisBTConnect(args: MantisBTConnectArgs): Promise<MantisBTConnectResult> {
    return connect(args)
  }

  mantisBTDisconnect(siteId?: string): { ok: true } {
    disconnect(siteId)
    return { ok: true }
  }

  mantisBTSelectSite(siteId: MantisBTSiteSelection): MantisBTConnectionStatus {
    return selectSite(siteId)
  }

  mantisBTStatus(): MantisBTConnectionStatus {
    return getStatus()
  }

  mantisBTTestConnection(siteId?: string): Promise<MantisBTConnectResult> {
    return testConnection(siteId)
  }

  mantisBTListIssues(
    filter?: MantisBTIssueFilter,
    limit = 30,
    siteId?: MantisBTSiteSelection | null,
    projectId?: string | null,
    signal?: AbortSignal
  ): Promise<MantisBTIssue[]> {
    return listIssues(filter, limit, siteId, projectId, signal)
  }

  mantisBTGetIssue(
    id: string,
    siteId?: MantisBTSiteSelection | null,
    signal?: AbortSignal
  ): Promise<MantisBTIssue | null> {
    return getIssue(id, siteId, signal)
  }

  mantisBTListProjects(
    siteId?: MantisBTSiteSelection | null,
    signal?: AbortSignal
  ): Promise<MantisBTProject[]> {
    return listProjects(siteId, signal)
  }
}
