export function relayLoadFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error)
  const tokenExchange = /^relay token exchange failed: ([1-5][0-9]{2})$/.exec(message)
  if (tokenExchange) return `token_http_${tokenExchange[1]}`
  const assignment =
    /^relay assignment failed: ([1-5][0-9]{2})(?: (relay_capacity_exhausted|relay_connection_headroom_exhausted))?$/.exec(
      message
    )
  if (assignment?.[1] === '503' && assignment[2]) return 'assignment_capacity_exhausted'
  if (assignment) return `assignment_http_${assignment[1]}`
  const closed = /^control closed: ([0-9]{4})\b/.exec(message)
  if (closed) return `control_close_${closed[1]}`
  if (message === 'control open timeout') return 'control_open_timeout'
  if (message === 'control response timeout') return 'control_response_timeout'
  if (message === 'relay token exchange timeout') return 'token_timeout'
  if (message === 'relay assignment timeout') return 'assignment_timeout'
  if (message === 'WebSocket was closed before the connection was established') {
    return 'socket_closed_before_open'
  }
  if (message === 'relay token exchange omitted token') return 'token_response_invalid'
  if (message === 'relay assignment response invalid') return 'assignment_response_invalid'
  if (message === 'expected host challenge') return 'host_challenge_invalid'
  if (message === 'host proof challenge did not decrypt') return 'host_challenge_decrypt_failed'
  if (message === 'expected host hello acknowledgement') return 'host_ack_invalid'
  const socketResponse = /^Unexpected server response: ([1-5][0-9]{2})\b/.exec(message)
  if (socketResponse) return `socket_http_${socketResponse[1]}`
  if (/\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT)\b/.test(message)) {
    return 'socket_transport'
  }
  return 'unknown'
}

export function discardFailedLoadSocket(socket) {
  if (!socket) return
  socket.on('error', () => undefined)
  socket.terminate()
}
