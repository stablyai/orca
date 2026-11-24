const CANCELLED_CONNECT_ATTEMPT_MESSAGE = 'SSH connection attempt was cancelled'
const CANCELLED_CONNECT_ATTEMPT_NAME = 'SshConnectAttemptCancelledError'

// Cancellation means a newer attempt/disconnect owns state; identify it without publishing a stale permanent error.
export function createCancelledConnectAttemptError(): Error {
  const error = new Error(CANCELLED_CONNECT_ATTEMPT_MESSAGE)
  error.name = CANCELLED_CONNECT_ATTEMPT_NAME
  return error
}

// All producers use the factory; message matches would misclassify unrelated errors.
export function isCancelledConnectAttemptError(err: Error): boolean {
  return err.name === CANCELLED_CONNECT_ATTEMPT_NAME
}
