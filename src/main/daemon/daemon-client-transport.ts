import { readFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { connectDaemonSocket } from './daemon-client-socket-connect'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { DaemonProtocolError } from './types'

export type DaemonTransportOperation = { timeoutMs: number; signal: AbortSignal }
export type DaemonClientTransport = {
  readToken: (operation: DaemonTransportOperation) => string | Promise<string>
  /** Return a connected ordered byte stream; destroy must release its bridge resources. */
  connect: (role: 'control' | 'stream', operation: DaemonTransportOperation) => Promise<Duplex>
}
export type DaemonClientOptions = {
  protocolVersion?: number
  admitIdentity?: (identity: DaemonEndpointIdentity | null) => Promise<void>
} & (
  | { socketPath: string; tokenPath: string; transport?: never }
  | { transport: DaemonClientTransport; socketPath?: never; tokenPath?: never }
)

export function resolveDaemonTransport(options: DaemonClientOptions): DaemonClientTransport {
  if (options.transport) {
    return options.transport
  }
  return {
    readToken: () => {
      try {
        return readFileSync(options.tokenPath, 'utf-8').trim()
      } catch (error) {
        // Missing auth must not preempt the connection that proves endpoint absence.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return ''
        }
        throw error
      }
    },
    connect: (_role, { timeoutMs }) => connectDaemonSocket(options.socketPath, timeoutMs)
  }
}

/** Bound transports that ignore cancellation, disposing streams that arrive too late. */
export function awaitDaemonTransport<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
  operation: DaemonTransportOperation,
  disposeLate?: (value: T) => void
): Promise<T> {
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      operation.signal.removeEventListener('abort', abort)
      complete()
    }
    const fail = (error: unknown): void =>
      settle(() => {
        controller.abort(error)
        reject(error)
      })
    const abort = (): void =>
      fail(operation.signal.reason ?? new DaemonProtocolError('Disconnected'))
    const timer = setTimeout(
      () => fail(new DaemonProtocolError('Connection timed out')),
      operation.timeoutMs
    )
    operation.signal.addEventListener('abort', abort, { once: true })
    if (operation.signal.aborted) {
      abort()
      return
    }
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          throw controller.signal.reason
        }
        return run(controller.signal)
      })
      .then(
        (value) => (settled ? disposeLate?.(value) : settle(() => resolve(value))),
        (error) => fail(error)
      )
  })
}

export function destroyDaemonTransport(stream: Duplex): void {
  // A bridge can report its exit asynchronously after destroy.
  stream.once('error', () => {})
  stream.destroy()
}
