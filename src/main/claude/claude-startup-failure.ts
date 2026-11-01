import { findInErrorChain } from '../provider-process/provider-error-chain'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'

/** SDK runtime tags are not in its public Error declaration. */
export function claudeStartupErrorClass(error: Error): string | undefined {
  return 'errorClass' in error && typeof error.errorClass === 'string'
    ? error.errorClass
    : undefined
}

export function claudeStartupAnswer(error: Error): 'temporary' | 'final' | undefined {
  const tag = claudeStartupErrorClass(error)
  if (tag === 'process_exited_nonzero' || tag === 'process_killed_by_signal') {
    return 'temporary'
  }
  if (tag === 'executable_launch_failed' || tag === 'spawn_failed' || tag === 'process_error') {
    return resourcePressure(error) ? 'temporary' : 'final'
  }
  if (tag !== undefined) {
    return 'final'
  }
  if (error instanceof ClaudeControlRequestError) {
    const origin = findInErrorChain(error.cause, (cause) => claudeStartupErrorClass(cause))
    if (
      origin === 'executable_launch_failed' ||
      origin === 'spawn_failed' ||
      origin === 'process_error'
    ) {
      return resourcePressure(error) ? 'temporary' : 'final'
    }
    return origin === 'process_exited_nonzero' || origin === 'process_killed_by_signal'
      ? 'temporary'
      : 'final'
  }
  return undefined
}

function resourcePressure(error: Error): boolean {
  return (
    findInErrorChain(error, (cause) =>
      'code' in cause && ['EAGAIN', 'EMFILE', 'ENFILE'].some((code) => cause.code === code)
        ? true
        : undefined
    ) === true
  )
}
