import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../../shared/timer-delay'

const PIPE_BUSY_RETRY_BASE_MS = 25
const PIPE_BUSY_RETRY_MAX_MS = 250

export async function sendRequest<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  if (!isSafeTimerDelayMs(timeoutMs)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }
  return await new Promise((resolve, reject) => {
    const transport = findTransport(metadata, 'unix', 'named-pipe')
    if (!transport) {
      reject(
        new RuntimeClientError(
          'runtime_unavailable',
          'No compatible transport found in Orca runtime metadata.'
        )
      )
      return
    }
    let socket: ReturnType<typeof createConnection> | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let lineSegments: string[] = []
    let settled = false
    const requestId = randomUUID()
    const openingDeadline = Date.now() + timeoutMs

    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      lineSegments = []
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      socket?.destroy()
      reject(
        new RuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the Orca runtime to respond.'
        )
      )
    }, timeoutMs)

    const finish = (
      result: { ok: true; response: RuntimeRpcResponse<TResult> } | { ok: false; error: Error }
    ): void => {
      if (settled) {
        return
      }
      settled = true
      lineSegments = []
      clearTimeout(timeout)
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      socket?.end()
      if (result.ok === false) {
        reject(result.error)
      } else {
        resolve(result.response)
      }
    }

    const onData = (chunk: string): void => {
      // Why: the server may interleave `{"_keepalive":true}\n` frames with the
      // final success/failure frame to keep both idle timers alive during a
      // long-poll (see design doc §3.1). Read frames in a loop until we see a
      // terminal frame. Each keepalive refreshes the client-side timer so a
      // 10 min wait doesn't trip the 60 s default ceiling.
      let cursor = 0
      while (cursor < chunk.length && !settled) {
        const newlineIndex = chunk.indexOf('\n', cursor)
        if (newlineIndex === -1) {
          lineSegments.push(chunk.slice(cursor))
          return
        }
        const segment = chunk.slice(cursor, newlineIndex)
        let line = segment
        if (lineSegments.length > 0) {
          lineSegments.push(segment)
          line = lineSegments.join('')
          lineSegments = []
        }
        cursor = newlineIndex + 1
        if (line.trim().length === 0) {
          continue
        }

        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          })
          return
        }

        // Fast-path: ignore keepalives without running the full schema.
        // setTimeout().refresh() is stable since Node 10 (Orca ships on
        // Node 20+ via Electron and the standalone CLI targets the same
        // major). See §7 risk #9.
        if (isKeepaliveFrame(raw)) {
          timeout.refresh()
          continue
        }

        // Why: validate the envelope shape (id, ok, result/error, _meta) at
        // the decode boundary so version skew between the CLI and the Orca
        // main runtime surfaces as a single invalid_runtime_response instead
        // of a downstream mis-typed field access. `result` is left as
        // unknown — the TResult generic is the caller's responsibility.
        const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
        if (!parsed.success) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          })
          return
        }

        // Narrow out keepalive (already filtered above) so TS can see a
        // Success|Failure shape here.
        const frame = parsed.data
        if ('_keepalive' in frame) {
          timeout.refresh()
          continue
        }

        const response = frame as RuntimeRpcResponse<TResult>
        if (response.id !== requestId) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned a mismatched response id.'
            )
          })
          return
        }
        if (response._meta?.runtimeId && response._meta.runtimeId !== metadata.runtimeId) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'runtime_unavailable',
              'The Orca runtime changed while the request was in flight. Retry the command.'
            )
          })
          return
        }
        finish({ ok: true, response })
        return
      }
    }

    const open = (attempt: number): void => {
      if (settled) {
        return
      }
      const attemptSocket = createConnection(transport.endpoint)
      socket = attemptSocket
      let requestSent = false
      let retired = false
      attemptSocket.setEncoding('utf8')
      attemptSocket.once('error', (error: NodeJS.ErrnoException) => {
        if (retired || settled) {
          return
        }
        if (!requestSent && error.code === 'EBUSY') {
          retired = true
          attemptSocket.destroy()
          const remaining = openingDeadline - Date.now()
          const delay = Math.min(
            PIPE_BUSY_RETRY_BASE_MS * 2 ** attempt,
            PIPE_BUSY_RETRY_MAX_MS,
            remaining
          )
          if (delay > 0) {
            retryTimer = setTimeout(() => {
              retryTimer = null
              if (Date.now() < openingDeadline) {
                open(attempt + 1)
              }
            }, delay)
          }
          return
        }
        finish({
          ok: false,
          error: connectionError(error)
        })
      })
      // Why: a clean peer close (FIN, no 'error') before a terminal frame never
      // settles the promise, so the call would otherwise hang until the full
      // timeout fires. A retired EBUSY attempt is excluded from this terminal path.
      attemptSocket.once('close', () => {
        if (retired) {
          return
        }
        finish({
          ok: false,
          error: new RuntimeClientError(
            'runtime_unavailable',
            'The Orca runtime closed the connection before responding. Restart Orca and try again.'
          )
        })
      })
      attemptSocket.on('data', onData)
      attemptSocket.once('connect', () => {
        if (settled || retired) {
          return
        }
        // The retry boundary ends here. Once any request byte may have been
        // handed to the socket, replaying it could execute an operation twice.
        requestSent = true
        attemptSocket.write(
          `${JSON.stringify({
            id: requestId,
            authToken: metadata.authToken,
            method,
            params,
            orchestrationCapability: envelope?.orchestrationCapability,
            orchestrationContractVersion: envelope?.orchestrationContractVersion,
            orchestrationRequestId: envelope?.orchestrationRequestId,
            compatibilityInvocationId: envelope?.compatibilityInvocationId,
            orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence
          })}\n`
        )
      })
    }

    open(0)
  })
}

function connectionError(error: NodeJS.ErrnoException): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Could not connect to the running Orca app. Restart Orca and try again.',
    {
      connectionError: {
        code: error.code ?? null,
        errno: error.errno ?? null,
        syscall: error.syscall ?? null
      }
    }
  )
}
