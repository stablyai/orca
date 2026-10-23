import type { JiraSite } from '../../../shared/jira-types'
import { apiBasePath } from '../authenticated-request'
import { isJiraGatewayBaseUrl } from '../gateway-base-url'
import type { AttachmentMeta } from './meta'

export function attachmentContentUrl(site: JiraSite, meta: AttachmentMeta): URL | null {
  if (!meta.contentUrl && site.authType === 'server') {
    return null
  }
  const contentUrl = meta.contentUrl ? new URL(meta.contentUrl, `${site.siteUrl}/`) : null
  const scopedSiteAttachment =
    contentUrl?.origin === new URL(site.siteUrl).origin &&
    site.authType !== 'server' &&
    isJiraGatewayBaseUrl(site.apiBaseUrl) &&
    !contentUrl.pathname.startsWith('/rest/')
  const url =
    contentUrl && !scopedSiteAttachment
      ? contentUrl
      : new URL(
          `${apiBasePath(site)}/attachment/content/${encodeURIComponent(meta.id)}`,
          site.siteUrl
        )
  if (/\/rest\/api\/(?:2|3)\/attachment\/content\/[^/]+$/i.test(url.pathname)) {
    url.searchParams.set('redirect', 'false')
  }
  return url
}
