export type TransportFailure = {
  outcome: 'socket_error' | 'timeout' | 'closed' | 'invalid_response' | 'identity_changed'
  connected?: boolean
  code?: string
  errno?: number
  syscall?: string
}

/** Capture only native diagnostic fields; messages and endpoints may contain secrets. */
export function socketFailure(error: NodeJS.ErrnoException): TransportFailure {
  const code =
    typeof error.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined
  const syscall = ['connect', 'read', 'write', 'pipe'].includes(error.syscall ?? '')
    ? error.syscall
    : undefined
  return {
    outcome: 'socket_error',
    ...(code ? { code } : {}),
    ...(Number.isSafeInteger(error.errno) ? { errno: error.errno } : {}),
    ...(syscall ? { syscall } : {})
  }
}
