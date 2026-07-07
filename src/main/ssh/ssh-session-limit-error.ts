export function isSshSessionLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const reason = (err as { reason?: unknown }).reason
  const message = err.message.toLowerCase()
  // Why: OpenSSH rejects session channels over MaxSessions with
  // SSH2_OPEN_CONNECT_FAILED (2) and the literal description "open failed";
  // reason 4 (resource shortage) covers other server implementations.
  if (
    (reason === 2 || reason === 4) &&
    (message.includes('channel open failure') || message.includes('open failed'))
  ) {
    return true
  }
  return (
    message.includes('no free channels available') ||
    message.includes('maxsessions') ||
    message.includes('session open refused') ||
    (message.includes('mux_client_request_session') && message.includes('session request failed'))
  )
}
