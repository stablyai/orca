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

// ClickUp also answers 401 (OAUTH_027, "Team not authorized") for a resource the token cannot reach, which must not revoke the token.
const CREDENTIAL_REJECTED_CODES = new Set(['OAUTH_017', 'OAUTH_019', 'OAUTH_023'])

export function isClickUpAuthError(error: unknown): boolean {
  return (
    error instanceof ClickUpApiError &&
    error.status === 401 &&
    (error.code === null || CREDENTIAL_REJECTED_CODES.has(error.code))
  )
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
  return new ClickUpApiError(message, response.status, code)
}
