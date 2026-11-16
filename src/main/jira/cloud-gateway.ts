import { JiraApiError, jiraFetch } from './authenticated-request'
import { jiraGatewayBaseUrl } from './gateway-base-url'

export async function resolveJiraGatewayBaseUrl(siteUrl: string): Promise<string> {
  const tenantInfoUrl = new URL('/_edge/tenant_info', siteUrl).toString()
  const response = await jiraFetch(tenantInfoUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'Orca' }
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new JiraApiError(
      `Could not resolve the Atlassian cloud ID at ${new URL(tenantInfoUrl).host}/_edge/tenant_info (HTTP ${response.status}). Check the Jira Cloud site URL.`,
      response.status
    )
  }
  const data: unknown = await response.json()
  return jiraGatewayBaseUrl(
    data && typeof data === 'object' && 'cloudId' in data ? data.cloudId : undefined
  )
}
