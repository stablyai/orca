import type { JiraSite, JiraUser, JiraViewer } from '../../shared/types'

type JiraRecord = Record<string, unknown>

function asRecord(value: unknown): JiraRecord {
  return value && typeof value === 'object' ? (value as JiraRecord) : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

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

export function toServerJiraViewer(data: JiraRecord, fallbackUsername = ''): JiraViewer {
  const userId =
    asString(data.name) ||
    asString(data.key) ||
    asString(data.emailAddress) ||
    asString(data.displayName) ||
    fallbackUsername
  return {
    userId,
    accountId: userId,
    displayName: asString(data.displayName, userId || fallbackUsername),
    email: typeof data.emailAddress === 'string' ? data.emailAddress : null,
    avatarUrl: getJiraAvatarUrl(data)
  }
}

export function mapJiraUser(value: unknown, site?: JiraSite): JiraUser | undefined {
  const user = asRecord(value)
  const cloudAccountId = asString(user.accountId)
  const serverUserId =
    asString(user.name) ||
    asString(user.key) ||
    asString(user.emailAddress) ||
    asString(user.displayName)
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
