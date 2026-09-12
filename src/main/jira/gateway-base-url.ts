export const ATLASSIAN_GATEWAY_ORIGIN = 'https://api.atlassian.com'

// Why: cloud ids are UUIDs; the class covers that plus the characters
// `encodeURIComponent` can emit, so a stored value is validated against the
// same shape `jiraGatewayBaseUrl` produces.
const GATEWAY_BASE_URL_RE = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[A-Za-z0-9._~%-]+$/

export function jiraGatewayBaseUrl(cloudId: string): string {
  return `${ATLASSIAN_GATEWAY_ORIGIN}/ex/jira/${encodeURIComponent(cloudId)}`
}

/** True only for `https://api.atlassian.com/ex/jira/<cloudId>` with no trailing path, port, or query. */
export function isJiraGatewayBaseUrl(value: unknown): value is string {
  return typeof value === 'string' && GATEWAY_BASE_URL_RE.test(value)
}
