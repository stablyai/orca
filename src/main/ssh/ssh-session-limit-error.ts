export function isSshSessionLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const reason = (err as { reason?: unknown }).reason
  const message = err.message.toLowerCase()
  if (
    reason === 4 &&
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
