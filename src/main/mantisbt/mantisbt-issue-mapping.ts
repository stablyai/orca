import type {
  MantisBTIssue,
  MantisBTIssuePriority,
  MantisBTIssueStatus,
  MantisBTProject,
  MantisBTSite,
  MantisBTUser
} from '../../shared/mantisbt-types'
import { asRecord, asString } from './mantisbt-record-pages'

function asIdentifier(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function mapMantisBTUser(value: unknown): MantisBTUser | undefined {
  const user = asRecord(value)
  const id = asIdentifier(user.id)
  if (!id) {
    return undefined
  }
  return {
    id,
    name: asString(user.name, asString(user.username, id)),
    realName: asString(user.real_name) || undefined
  }
}

function mapMantisBTStatus(value: unknown): MantisBTIssueStatus {
  const status = asRecord(value)
  return {
    id: asIdentifier(status.id),
    name: asString(status.name, 'Unknown'),
    label: asString(status.label, asString(status.name, 'Unknown'))
  }
}

function mapMantisBTPriority(value: unknown): MantisBTIssuePriority | undefined {
  const priority = asRecord(value)
  const id = asIdentifier(priority.id)
  if (!id) {
    return undefined
  }
  return {
    id,
    name: asString(priority.name, 'Priority'),
    label: asString(priority.label, asString(priority.name, 'Priority'))
  }
}

export function mapMantisBTProject(site: MantisBTSite, value: unknown): MantisBTProject {
  const project = asRecord(value)
  const id = asIdentifier(project.id)
  return {
    id,
    siteId: site.id,
    name: asString(project.name, id || 'Untitled project'),
    subProjects: []
  }
}

export function issueUrl(site: MantisBTSite, id: string): string {
  return `${site.siteUrl}/view.php?id=${id}`
}

export function mapMantisBTIssue(site: MantisBTSite, raw: Record<string, unknown>): MantisBTIssue {
  const id = asIdentifier(raw.id)
  // Why: created_at/updated_at absent would otherwise silently report the
  // lookup time as the issue's timestamps rather than surfacing the gap
  // (mirrors Jira's ISSUE_SUMMARY_FIELDS "now" fallback rationale).
  const now = new Date().toISOString()
  return {
    id,
    summary: asString(raw.summary),
    description: asString(raw.description) || undefined,
    project: mapMantisBTProject(site, raw.project),
    status: mapMantisBTStatus(raw.status),
    priority: mapMantisBTPriority(raw.priority),
    reporter: mapMantisBTUser(raw.reporter),
    handler: raw.handler === null ? null : mapMantisBTUser(raw.handler),
    createdAt: asString(raw.created_at, now),
    updatedAt: asString(raw.updated_at, now),
    siteId: site.id,
    siteName: site.displayName,
    url: issueUrl(site, id)
  }
}
