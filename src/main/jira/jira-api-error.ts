import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
    public scopeMismatch = false
  ) {
    super(message)
  }
}

async function readJiraError(response: Response, maxResponseBytes?: number): Promise<string> {
  try {
    const data: unknown =
      maxResponseBytes === undefined
        ? await response.json()
        : await readFetchResponseJsonWithinLimit(response, maxResponseBytes)
    if (data && typeof data === 'object') {
      const messages: unknown[] = []
      if ('errorMessages' in data && Array.isArray(data.errorMessages)) {
        messages.push(...data.errorMessages)
      }
      if ('errors' in data && data.errors && typeof data.errors === 'object') {
        messages.push(...Object.values(data.errors))
      }
      if ('message' in data) {
        messages.push(data.message)
      }
      const strings = messages.filter((message): message is string => typeof message === 'string')
      if (strings.length > 0) {
        return strings.join('; ')
      }
    }
  } catch {
    // Fall through for non-JSON responses.
  }
  return response.statusText || `Jira request failed (${response.status})`
}

export async function toJiraApiError(
  response: Response,
  url: string,
  maxResponseBytes?: number
): Promise<JiraApiError> {
  const message = await readJiraError(response, maxResponseBytes)
  const target = new URL(url)
  const scopeMismatch =
    target.origin === 'https://api.atlassian.com' &&
    (response.status === 401 || response.status === 403) &&
    /scope does not match|insufficient_scope|scope mismatch/i.test(
      `${message} ${response.headers.get('www-authenticate') ?? ''}`
    )
  if (scopeMismatch) {
    const scope = /\/(myself|user|users)(\/|$)/.test(target.pathname)
      ? 'read:jira-user'
      : 'read:jira-work for reads or write:jira-work for edits'
    return new JiraApiError(
      `Jira rejected this request's API token scopes at ${target.host}${target.pathname} (HTTP ${response.status}). Add ${scope}; board ordering also needs the Jira Software board scopes listed in the connection guide.`,
      response.status,
      true
    )
  }
  return new JiraApiError(message, response.status)
}
