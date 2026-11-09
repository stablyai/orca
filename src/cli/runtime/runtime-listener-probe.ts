import { createConnection } from 'node:net'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

export const RUNTIME_LISTENER_PROBE_TIMEOUT_MS = 250

/** An unproven connection does not establish absence. */
export type RuntimeListenerProbe = 'accepting' | 'not-listening' | 'unproven'

/** Only a missing or refused endpoint proves no listener exists. */
const NOT_LISTENING_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

/** PIDs recycle; a listening endpoint proves a live owner even when RPC is unresponsive. */
export function probeRuntimeListener(
  metadata: RuntimeMetadata,
  timeoutMs: number = RUNTIME_LISTENER_PROBE_TIMEOUT_MS
): Promise<RuntimeListenerProbe> {
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  const endpoint = transport?.endpoint
  // Invalid endpoints can throw or be interpreted as unrelated TCP ports.
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    return Promise.resolve('not-listening')
  }
  return new Promise((resolve) => {
    const socket = createConnection(endpoint)
    let settled = false
    const settle = (result: RuntimeListenerProbe): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    // A timeout cannot prove the profile is free; bound the wait on the launch path.
    const timer = setTimeout(() => settle('unproven'), timeoutMs)
    socket.once('connect', () => settle('accepting'))
    // A socket destroyed mid-connect may emit another error; keep its listener installed.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle(NOT_LISTENING_CODES.has(error.code ?? '') ? 'not-listening' : 'unproven')
    })
  })
}
