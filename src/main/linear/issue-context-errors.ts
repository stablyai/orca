import type { LinearErrorCode, LinearIncludeErrorCode } from '../../shared/linear-agent-access'

export class LinearAgentAccessError extends Error {
  readonly code: LinearErrorCode
  readonly data?: unknown

  constructor(code: LinearErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'LinearAgentAccessError'
    this.code = code
    this.data = data
  }
}

export function linearError(
  code: LinearErrorCode,
  message: string,
  data?: unknown
): LinearAgentAccessError {
  return new LinearAgentAccessError(code, message, data)
}

export function includeErrorCode(error: unknown): LinearIncludeErrorCode {
  if (error instanceof LinearAgentAccessError) {
    if (
      error.code === 'linear_timeout' ||
      error.code === 'linear_rate_limited' ||
      error.code === 'linear_permission_denied' ||
      error.code === 'linear_auth_expired' ||
      error.code === 'linear_network_error'
    ) {
      return error.code
    }
  }
  return 'linear_include_failed'
}

export function classifyLinearError(error: unknown): LinearErrorCode {
  const message = linearMessage(error).toLowerCase()
  if (message.includes('rate limit') || message.includes('429')) {
    return 'linear_rate_limited'
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'linear_timeout'
  }
  if (message.includes('permission') || message.includes('forbidden') || message.includes('403')) {
    return 'linear_permission_denied'
  }
  if (
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('fetch failed')
  ) {
    return 'linear_network_error'
  }
  return 'linear_network_error'
}

export function linearMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
