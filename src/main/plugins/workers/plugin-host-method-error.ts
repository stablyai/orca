import type { PluginErrorCode } from '../../../shared/plugins/frames/plugin-protocol'

/**
 * Thrown by a host method handler to answer with a specific error code instead of the generic
 * `action_failed`. Reserved for codes a plugin can act on, such as `rate_limited` with the wait
 * the caller should observe before trying again.
 */
export class PluginHostMethodError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'PluginHostMethodError'
  }
}
