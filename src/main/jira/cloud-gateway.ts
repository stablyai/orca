import { JiraApiError, jiraFetch } from './authenticated-request'
import { jiraGatewayBaseUrl } from './gateway-base-url'

/**
 * Scoped Atlassian API tokens only work on the api.atlassian.com gateway, which
 * addresses a site by cloudId rather than hostname. The site publishes its
 * cloudId unauthenticated, so no credential is needed to look it up.
 */
export async function resolveJiraGatewayBaseUrl(siteUrl: string): Promise<string> {
  const tenantInfoUrl = new URL('/_edge/tenant_info', siteUrl).toString()
  const response = await jiraFetch(tenantInfoUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'Orca' }
  })
  if (!response.ok) {
    throw new JiraApiError(
      `Could not resolve the Atlassian cloud id for this site (HTTP ${response.status}). Scoped API tokens need an Atlassian Cloud site.`,
      response.status
    )
  }
  const cloudId = ((await response.json()) as { cloudId?: unknown }).cloudId
  if (typeof cloudId !== 'string' || !cloudId.trim()) {
    throw new JiraApiError('The site did not report an Atlassian cloud id.', null)
  }
  return jiraGatewayBaseUrl(cloudId.trim())
}
