import { createConnection } from 'node:net'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

export const RUNTIME_LISTENER_PROBE_TIMEOUT_MS = 250

/** What a connect to the published endpoint proved — `unproven` is not an absence. */
export type RuntimeListenerProbe = 'accepting' | 'not-listening' | 'unproven'

/** Why: measured on macOS — a stopped runtime unlinks its socket (ENOENT) and a SIGKILLed one leaves a path that refuses (ECONNREFUSED). Both land in <1ms, so these are the only outcomes that prove nobody is home. */
const NOT_LISTENING_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

/**
 * Why: a recorded pid is weak evidence — the OS recycles pids. The runtime binds its
 * endpoints before publishing metadata, so an accepted connect proves a live owner
 * even when it is too busy for RPC; a crash leaves a path with nothing accepting.
 */
export function probeRuntimeListener(
  metadata: RuntimeMetadata,
  timeoutMs: number = RUNTIME_LISTENER_PROBE_TIMEOUT_MS
): Promise<RuntimeListenerProbe> {
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  const endpoint = transport?.endpoint
  // Why: metadata is unvalidated JSON from disk. A missing or blank endpoint makes
  // createConnection throw out of serve, and a numeric one is read as a TCP port —
  // it would dial 127.0.0.1 and could be answered by something that is not Orca.
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
    // Why: a connect that neither lands nor is refused means something still holds the
    // endpoint, so it is no proof the profile is free. Capped because this is the launch path.
    const timer = setTimeout(() => settle('unproven'), timeoutMs)
    socket.once('connect', () => settle('accepting'))
    // Why: `on`, not `once` — a socket destroyed mid-connect can emit again, and a
    // second error with no listener left would take down the CLI.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle(NOT_LISTENING_CODES.has(error.code ?? '') ? 'not-listening' : 'unproven')
    })
  })
}
