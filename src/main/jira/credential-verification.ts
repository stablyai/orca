import type { JiraAuthType, JiraViewer } from '../../shared/jira/jira-types'
import { JiraApiError, requestWithCredentials } from './authenticated-request'
import { resolveJiraGatewayBaseUrl } from './cloud-gateway'
import { toViewer } from './site-identity'

function endpointLabel(baseUrl: string, path: string): string {
  const url = new URL(`${baseUrl}${path}`)
  return `${url.host}${url.pathname}`
}

function describeFailure(error: unknown, endpoint: string): string {
  if (error instanceof JiraApiError) {
    if (error.scopeMismatch) {
      return error.message
    }
    const status = error.status === null ? '' : ` (HTTP ${error.status})`
    if (error.status === 401) {
      return `Jira rejected the credential at ${endpoint}${status}. Check the account email, token expiry, and access to this site.`
    }
    if (error.status === 403) {
      return `Jira denied access at ${endpoint}${status}. Check account permissions and API token scopes.`
    }
    if (error.status === 200) {
      return `Jira returned an unexpected account response at ${endpoint}${status}. Check that the site URL includes the Jira installation's base path.`
    }
    return `Jira could not verify the credential at ${endpoint}${status}. Check the site URL and Jira availability.`
  }
  return `Could not reach ${endpoint}. Check the connection, proxy, and Jira site URL.`
}

async function verifyViewer(
  baseUrl: string,
  email: string,
  apiToken: string,
  authType: JiraAuthType
): Promise<JiraViewer> {
  const path = authType === 'server' ? '/rest/api/2/myself' : '/rest/api/3/myself'
  let data: unknown
  try {
    data = await requestWithCredentials(baseUrl, email, apiToken, path, undefined, authType)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new JiraApiError('Jira returned a non-JSON account response.', 200)
    }
    throw error
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new JiraApiError('Jira returned an invalid account response.', 200)
  }
  const viewer = toViewer(Object.fromEntries(Object.entries(data)), email || baseUrl)
  if (!viewer.accountId) {
    throw new JiraApiError('Jira did not return an account identity.', 200)
  }
  return viewer
}

export async function verifyJiraCredentials(
  siteUrl: string,
  email: string,
  apiToken: string,
  authType: JiraAuthType
): Promise<{ viewer: JiraViewer; apiBaseUrl?: string }> {
  const path = authType === 'server' ? '/rest/api/2/myself' : '/rest/api/3/myself'
  let siteFailure: string | undefined
  if (email || authType === 'server') {
    try {
      return { viewer: await verifyViewer(siteUrl, email, apiToken, authType) }
    } catch (error) {
      siteFailure = describeFailure(error, endpointLabel(siteUrl, path))
      if (authType === 'server' || !(error instanceof JiraApiError) || error.status !== 401) {
        throw new Error(siteFailure)
      }
    }
  }

  // Scoped tokens are rejected by the site host; keep browse links there and send REST to the gateway.
  let apiBaseUrl: string
  try {
    apiBaseUrl = await resolveJiraGatewayBaseUrl(siteUrl)
  } catch (error) {
    const detail =
      error instanceof JiraApiError
        ? error.message
        : 'Could not resolve a valid Atlassian cloud ID. Check the Jira Cloud site URL and connection.'
    throw new Error(siteFailure ? `${siteFailure} ${detail}` : detail)
  }
  try {
    return { viewer: await verifyViewer(apiBaseUrl, email, apiToken, authType), apiBaseUrl }
  } catch (error) {
    const detail = describeFailure(error, endpointLabel(apiBaseUrl, path))
    throw new Error(siteFailure ? `${siteFailure} Gateway check: ${detail}` : detail)
  }
}
