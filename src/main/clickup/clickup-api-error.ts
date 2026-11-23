import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { readFetchResponseJsonWithinLimit } from '../../shared/network/fetch-response-body'

const ERROR_BODY_MAX_BYTES = 64 * 1024

export class ClickUpApiError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
    public code: string | null = null
  ) {
    super(message)
    this.name = 'ClickUpApiError'
  }
}

// "Token not found" (revoked) and "Authorization Header Required"; docs: developer.clickup.com/docs/common_errors.
const CREDENTIAL_REJECTED_CODES = new Set([
  'OAUTH_017',
  'OAUTH_019',
  'OAUTH_021',
  'OAUTH_025',
  'OAUTH_077'
])

// "Team not authorized": the token is valid but the Workspace is not authorized for it, so it must not be revoked.
const WORKSPACE_NOT_AUTHORIZED_CODES = new Set([
  'OAUTH_023',
  'OAUTH_026',
  'OAUTH_027',
  ...Array.from({ length: 17 }, (_, index) => `OAUTH_0${29 + index}`)
])

const WORKSPACE_NOT_AUTHORIZED_MESSAGE =
  'This ClickUp token is not authorized for that Workspace. Authorize the Workspace for the token, or use another one.'

export function isClickUpAuthError(error: unknown): boolean {
  return (
    error instanceof ClickUpApiError &&
    error.status === 401 &&
    (error.code === null || CREDENTIAL_REJECTED_CODES.has(error.code))
  )
}

/** An abort nobody asked for is the deadline firing; a caller's own cancellation passes through. */
export function toClickUpDeadlineError(error: unknown, callerSignal?: AbortSignal): unknown {
  if (callerSignal?.aborted || !(error instanceof Error) || error.name !== 'AbortError') {
    return error
  }
  return new ClickUpApiError('ClickUp took too long to respond. Try again.', null, 'TIMEOUT')
}

/** The task does not exist or the token has no access to it. */
export function isClickUpTaskUnavailableError(error: unknown): boolean {
  return (
    error instanceof ClickUpApiError &&
    (error.status === 404 ||
      error.status === 403 ||
      (error.status === 401 && !isClickUpAuthError(error)))
  )
}

export async function toClickUpApiError(response: Response): Promise<ClickUpApiError> {
  let message = response.statusText || `ClickUp request failed (${response.status})`
  let code: string | null = null
  try {
    const data: unknown = await readFetchResponseJsonWithinLimit(response, ERROR_BODY_MAX_BYTES)
    if (isRecord(data)) {
      if (typeof data.err === 'string' && data.err.trim()) {
        message = data.err.trim()
      }
      if (typeof data.ECODE === 'string') {
        code = data.ECODE
      }
    }
  } catch {
    // Non-JSON or oversized error bodies keep the status text.
    await response.body?.cancel().catch(() => undefined)
  }
  if (code !== null && WORKSPACE_NOT_AUTHORIZED_CODES.has(code)) {
    message = WORKSPACE_NOT_AUTHORIZED_MESSAGE
  }
  return new ClickUpApiError(message, response.status, code)
}
