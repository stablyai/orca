import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'

export type LocalRuntimeStream = {
  done: Promise<void>
  close: () => void
}

export function openLocalRuntimeStream<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number,
  onEvent: (event: RuntimeRpcSuccess<TResult>) => void
): LocalRuntimeStream {
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  if (!transport) {
    return rejectedStream(
      new RuntimeClientError(
        'runtime_unavailable',
        'No compatible transport found in Orca runtime metadata.'
      )
    )
  }

  const socket = createConnection(transport.endpoint)
  const requestId = randomUUID()
  let buffer = ''
  let settled = false
  let intentionalClose = false
  let receivedFrame = false
  let protocolEnded = false
  let resolveDone = (): void => {}
  let rejectDone = (_error: Error): void => {}
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const timeout = setTimeout(() => {
    fail(
      new RuntimeClientError('runtime_timeout', 'Timed out waiting for the Orca runtime stream.')
    )
  }, timeoutMs)

  const finish = (): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timeout)
    resolveDone()
  }
  const fail = (error: Error): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timeout)
    socket.destroy()
    rejectDone(error)
  }

  socket.setEncoding('utf8')
  socket.once('error', () => {
    if (intentionalClose) {
      finish()
      return
    }
    fail(
      new RuntimeClientError(
        'runtime_unavailable',
        'Could not connect to the running Orca app. Restart Orca and try again.'
      )
    )
  })
  socket.once('close', () => {
    if (intentionalClose || protocolEnded) {
      finish()
      return
    }
    fail(
      new RuntimeClientError(
        'runtime_unavailable',
        receivedFrame
          ? 'The Orca runtime closed the stream before its end frame.'
          : 'The Orca runtime closed the stream before responding.'
      )
    )
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1 && !settled) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      if (!line.trim()) {
        continue
      }

      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        fail(invalidResponse())
        return
      }
      if (isKeepaliveFrame(raw)) {
        timeout.refresh()
        continue
      }
      const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
      if (!parsed.success || '_keepalive' in parsed.data || parsed.data.id !== requestId) {
        fail(invalidResponse())
        return
      }
      if (parsed.data._meta?.runtimeId && parsed.data._meta.runtimeId !== metadata.runtimeId) {
        fail(
          new RuntimeClientError('runtime_unavailable', 'The Orca runtime changed while streaming.')
        )
        return
      }
      receivedFrame = true
      clearTimeout(timeout)
      if (parsed.data.ok === false) {
        fail(new RuntimeRpcFailureError(parsed.data))
        return
      }
      try {
        onEvent(parsed.data as RuntimeRpcSuccess<TResult>)
        const result = parsed.data.result
        if (
          typeof result === 'object' &&
          result !== null &&
          (result as { type?: unknown }).type === 'end'
        ) {
          protocolEnded = true
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  })
  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({
        id: requestId,
        authToken: metadata.authToken,
        method,
        params,
        stream: true
      })}\n`
    )
  })

  return {
    done,
    close: () =>
      closeStream(socket, () => {
        intentionalClose = true
      })
  }
}

function closeStream(socket: Socket, markIntentional: () => void): void {
  markIntentional()
  socket.end()
}

function invalidResponse(): RuntimeClientError {
  return new RuntimeClientError(
    'invalid_runtime_response',
    'The Orca runtime returned an invalid stream frame.'
  )
}

function rejectedStream(error: Error): LocalRuntimeStream {
  return { done: Promise.reject(error), close: () => {} }
}
