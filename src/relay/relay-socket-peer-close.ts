import type { Socket } from 'node:net'

// Why only these two: libuv folds the Windows pipe breaks (ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED,
// ERROR_BAD_PIPE) into EPIPE and ERROR_NETNAME_DELETED/WSAECONNRESET into ECONNRESET, and both
// mean the other end went away. ECANCELED and ECONNABORTED can come from our own close, so a
// teardown we started would clamp a live owner's grace (see pty-consumer-owner-admission.ts).
const PEER_CLOSED_SOCKET_ERROR_CODES: ReadonlySet<string> = new Set(['EPIPE', 'ECONNRESET'])

function hasPeerClosedCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  return typeof error.code === 'string' && PEER_CLOSED_SOCKET_ERROR_CODES.has(error.code)
}

/**
 * Whether a failed socket write (or a write attempted after destroy) is evidence the peer left.
 * ERR_STREAM_DESTROYED and a bare destroyed socket carry no cause of their own, so they count only
 * when the socket itself was destroyed by a peer-caused error; a plain destroy() leaves no error.
 */
export function isRelaySocketPeerClosed(socket: Socket, writeError?: unknown): boolean {
  return hasPeerClosedCode(writeError) || hasPeerClosedCode(socket.errored)
}
