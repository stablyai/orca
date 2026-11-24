const GATEWAY_BASE_URL_RE = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[A-Za-z0-9_-]+$/
const CLOUD_ID_RE = /^[A-Za-z0-9_-]+$/

export function jiraGatewayBaseUrl(cloudId: unknown): string {
  if (typeof cloudId !== 'string' || !CLOUD_ID_RE.test(cloudId)) {
    throw new Error('The site did not report a valid Atlassian cloud ID.')
  }
  return `https://api.atlassian.com/ex/jira/${cloudId}`
}

export function isJiraGatewayBaseUrl(value: unknown): value is string {
  return typeof value === 'string' && GATEWAY_BASE_URL_RE.test(value)
}
