import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { linearError, type LinearAgentAccessError } from '../linear/issue-context-errors'
import { LinearWriteFailure } from '../linear/linear-issue-write-support'

export async function runLinearCommentAction<Owner, Result>(
  resolveOwner: (signal: AbortSignal) => Promise<Owner>,
  write: (
    owner: Owner,
    options: { signal: AbortSignal; beforeInvoke: () => void }
  ) => Promise<Result>,
  unconfirmed: (owner: Owner) => LinearAgentAccessError,
  mapFailure: (error: unknown) => LinearAgentAccessError,
  cancellation?: AbortSignal
): Promise<{ owner: Owner; result: Result }> {
  const deadline = Date.now() + 55_000
  const discoveryDeadline = Date.now() + 30_000
  const action = new AbortController()
  const signal = cancellation ? AbortSignal.any([action.signal, cancellation]) : action.signal
  const timeout = (): LinearAgentAccessError =>
    linearError(
      'linear_timeout',
      'The Linear comment action stopped before a change was attempted.'
    )
  const totalTimer = setTimeout(() => action.abort(timeout()), 55_000)
  const discovery = new AbortController()
  let discoveryExpired = false
  const discoveryTimer = setTimeout(() => {
    discoveryExpired = true
    discovery.abort(timeout())
  }, 30_000)
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  let owner: Owner | undefined
  let invoked = false
  try {
    const discoverySignal = AbortSignal.any([signal, discovery.signal])
    try {
      discoverySignal.throwIfAborted()
      owner = await waitForPromiseWithSignal(resolveOwner(discoverySignal), discoverySignal)
      if (Date.now() >= discoveryDeadline) {
        discoveryExpired = true
        throw timeout()
      }
    } finally {
      clearTimeout(discoveryTimer)
      discovery.abort()
    }
    const writeDeadline = Math.min(deadline, Date.now() + 25_000)
    writeTimer = setTimeout(() => action.abort(timeout()), Math.max(0, writeDeadline - Date.now()))
    const beforeInvoke = (): void => {
      signal.throwIfAborted()
      if (Date.now() >= writeDeadline) {
        action.abort(timeout())
        signal.throwIfAborted()
      }
      invoked = true
    }
    signal.throwIfAborted()
    const result = await waitForPromiseWithSignal(write(owner, { signal, beforeInvoke }), signal)
    return { owner, result }
  } catch (error) {
    if (
      invoked &&
      owner !== undefined &&
      (signal.aborted || (error instanceof LinearWriteFailure && error.kind === 'unconfirmed'))
    ) {
      throw unconfirmed(owner)
    }
    if (signal.aborted || discoveryExpired) {
      throw timeout()
    }
    if (error instanceof LinearWriteFailure) {
      throw linearError(
        error.kind === 'network' ? 'linear_network_error' : 'linear_write_failed',
        'Linear could not complete the comment change. Retry after checking the comment.'
      )
    }
    throw mapFailure(error)
  } finally {
    clearTimeout(totalTimer)
    clearTimeout(discoveryTimer)
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer)
    }
  }
}
