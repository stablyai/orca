export const ATLASSIAN_GATEWAY_ORIGIN = 'https://api.atlassian.com'

// Why: cloud ids are UUIDs; the pattern covers that plus the well-formed `%XX`
// escapes `encodeURIComponent` can emit, so a stored value is validated against
// the same shape `jiraGatewayBaseUrl` produces.
const GATEWAY_BASE_URL_RE =
  /^https:\/\/api\.atlassian\.com\/ex\/jira\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/

export function jiraGatewayBaseUrl(cloudId: string): string {
  return `${ATLASSIAN_GATEWAY_ORIGIN}/ex/jira/${encodeURIComponent(cloudId)}`
}

/** True only for `https://api.atlassian.com/ex/jira/<cloudId>` with no trailing path, port, or query. */
export function isJiraGatewayBaseUrl(value: unknown): value is string {
  return typeof value === 'string' && GATEWAY_BASE_URL_RE.test(value)
}
