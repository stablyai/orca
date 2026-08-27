import { createHash } from 'node:crypto'
import type { JiraSite, JiraViewer } from '../../shared/jira-types'

export function normalizeJiraSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function getSiteId(siteUrl: string, email: string): string {
  return createHash('sha256')
    .update(`${siteUrl}\n${email.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

export function toViewer(data: Record<string, unknown>, fallbackEmail: string): JiraViewer {
  const avatarUrls = data.avatarUrls as Record<string, unknown> | undefined
  // Server/DC /myself has no accountId; its stable identifiers are name/key.
  const accountId =
    typeof data.accountId === 'string'
      ? data.accountId
      : typeof data.name === 'string'
        ? data.name
        : typeof data.key === 'string'
          ? data.key
          : ''
  return {
    accountId,
    displayName: typeof data.displayName === 'string' ? data.displayName : fallbackEmail,
    email: typeof data.emailAddress === 'string' ? data.emailAddress : fallbackEmail,
    avatarUrl:
      typeof avatarUrls?.['48x48'] === 'string'
        ? avatarUrls['48x48']
        : typeof avatarUrls?.['32x32'] === 'string'
          ? avatarUrls['32x32']
          : undefined
  }
}

export function siteToViewer(site: JiraSite | null): JiraViewer | null {
  if (!site) {
    return null
  }
  return {
    accountId: site.accountId,
    displayName: site.displayName,
    email: site.email
  }
}
