import type { JiraSite, JiraUser, JiraViewer } from '../../shared/types'
import { asRecord, asString, type JiraRecord } from './jira-record-primitives'

export function getJiraAvatarUrl(data: JiraRecord): string | undefined {
  const avatarUrls = asRecord(data.avatarUrls)
  return (
    asString(avatarUrls['48x48']) ||
    asString(avatarUrls['32x32']) ||
    asString(avatarUrls['24x24']) ||
    undefined
  )
}

export function jiraSiteToViewer(site: JiraSite | null): JiraViewer | null {
  if (!site) {
    return null
  }
  return {
    userId: site.viewerUserId,
    accountId: site.accountId,
    displayName: site.displayName,
    email: site.email
  }
}

export function toCloudJiraViewer(data: JiraRecord, fallbackEmail: string): JiraViewer {
  const accountId = asString(data.accountId)
  return {
    userId: accountId,
    accountId,
    displayName: asString(data.displayName, fallbackEmail),
    email: asString(data.emailAddress, fallbackEmail),
    avatarUrl: getJiraAvatarUrl(data)
  }
}

export function toServerJiraViewer(data: JiraRecord, displayNameFallback = ''): JiraViewer {
  const userId =
    // Why: persisted Server/DC site ids must not depend on mutable contact
    // or typed credential fields; only Jira's returned key/name are accepted.
    asString(data.key) || asString(data.name)
  return {
    userId,
    accountId: userId,
    displayName: asString(data.displayName, userId || displayNameFallback),
    email: typeof data.emailAddress === 'string' ? data.emailAddress : null,
    avatarUrl: getJiraAvatarUrl(data)
  }
}

export function mapJiraUser(value: unknown, site?: JiraSite): JiraUser | undefined {
  const user = asRecord(value)
  const cloudAccountId = asString(user.accountId)
  // Why: Server/DC assignment writes this value back as `{ name }`;
  // key/email/displayName are not safe substitutes.
  const serverUserId = asString(user.name)
  const userId = site?.deploymentType === 'server' ? serverUserId : cloudAccountId
  if (!userId) {
    return undefined
  }
  return {
    userId,
    accountId: cloudAccountId || userId,
    displayName: asString(user.displayName, 'Unknown'),
    email: typeof user.emailAddress === 'string' ? user.emailAddress : undefined,
    avatarUrl: getJiraAvatarUrl(user)
  }
}

export function jiraAssigneePayload(site: JiraSite, userId: string | null | undefined): JiraRecord {
  return site.deploymentType === 'server' ? { name: userId } : { accountId: userId }
}
