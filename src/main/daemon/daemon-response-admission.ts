import type { DaemonRequest } from './types'

export const DAEMON_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
export const DAEMON_RESPONSE_RESERVATION_BYTES = DAEMON_MAX_RESPONSE_BYTES
export const DAEMON_MAX_ACTIVE_RESPONSE_BYTES = 128 * 1024 * 1024
export const DAEMON_MAX_ACTIVE_RESPONSE_BYTES_PER_CLIENT = 64 * 1024 * 1024
export const DAEMON_CONTROL_PROCESS_MAX_BUFFERED_BYTES = 64 * 1024 * 1024

const REQUESTS_WITH_POTENTIALLY_LARGE_RESULTS = new Set<DaemonRequest['type']>([
  'createOrAttach',
  'getSnapshot',
  'listSessions',
  'takePendingOutput'
])

export function daemonResponseReservationBytes(request: DaemonRequest): number {
  return REQUESTS_WITH_POTENTIALLY_LARGE_RESULTS.has(request.type)
    ? DAEMON_RESPONSE_RESERVATION_BYTES
    : 0
}
