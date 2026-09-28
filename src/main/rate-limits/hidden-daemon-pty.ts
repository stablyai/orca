import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DaemonClient } from '../daemon/client'
import { getDaemonEndpointFacts } from '../daemon/daemon-provider-state'

const probeEvent = z.object({
  type: z.literal('event'),
  event: z.enum(['data', 'exit', 'terminalError']),
  sessionId: z.string(),
  payload: z.object({ data: z.string().optional(), code: z.number().optional() })
})
const capability = z.object({ capabilities: z.object({ transientPty: z.literal(1) }) })

export async function spawnHiddenDaemonPty(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name?: string },
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const endpoint = getDaemonEndpointFacts()
  if (!endpoint) {
    throw new Error('Terminal service unavailable for usage probe')
  }
  const client = new DaemonClient(endpoint)
  const id = randomUUID()
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number }) => void>()
  let pending = ''
  const errorListeners = new Set<(error: Error) => void>()
  let outcome: { exitCode: number } | Error | null = null
  const getFailure = (): Error | null => (outcome instanceof Error ? outcome : null)
  let delivered = false
  let closed = false
  let activationQueued = false
  const close = (): void => {
    if (closed) {
      client.disconnect()
      return
    }
    closed = true
    signal?.removeEventListener('abort', close)
    removeEvents()
    removeDisconnect()
    dataListeners.clear()
    exitListeners.clear()
    errorListeners.clear()
    pending = ''
    client.disconnect()
  }
  const drain = (): void => {
    if (activationQueued) {
      return
    }
    activationQueued = true
    queueMicrotask(() => {
      activationQueued = false
      if (closed) {
        return
      }
      if (pending && dataListeners.size) {
        const output = pending
        pending = ''
        for (const listener of dataListeners) {
          listener(output)
        }
      }
      if (closed || delivered || outcome === null) {
        return
      }
      if (outcome instanceof Error ? errorListeners.size : exitListeners.size) {
        delivered = true
        try {
          if (outcome instanceof Error) {
            for (const listener of errorListeners) {
              listener(outcome)
            }
          } else {
            for (const listener of exitListeners) {
              listener(outcome)
            }
          }
        } finally {
          close()
        }
      }
    })
  }
  const fail = (message: string): void => {
    if (closed || outcome !== null) {
      return
    }
    outcome = new Error(message)
    pending = ''
    client.disconnect()
    drain()
  }
  const removeEvents = client.onEvent((input) => {
    const parsed = probeEvent.safeParse(input)
    if (!parsed.success || parsed.data.sessionId !== id || closed || outcome !== null) {
      return
    }
    const event = parsed.data
    if (event.event === 'data' && event.payload.data !== undefined) {
      pending += event.payload.data
      if (pending.length > 128 * 1024) {
        fail('Usage probe output exceeded its buffer limit')
        return
      }
    } else if (event.event === 'exit' && event.payload.code !== undefined) {
      outcome = { exitCode: event.payload.code }
    } else if (event.event !== 'data') {
      fail('Terminal service could not complete the usage probe')
      return
    }
    drain()
  })
  const removeDisconnect = client.onDisconnected(() => {
    fail('Terminal service connection lost during usage probe')
  })
  signal?.addEventListener('abort', close, { once: true })
  try {
    await client.ensureConnected()
    signal?.throwIfAborted()
    if (!capability.safeParse(await client.request('ping', {}, 5_000, signal)).success) {
      throw new Error(
        'Running terminal service does not support hidden usage probes; retry after its terminals close'
      )
    }
    const env = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
    const result = await client.request<{ pid: number }>(
      'createTransientPty',
      {
        id,
        file,
        args,
        cwd: options.cwd,
        env,
        cols: options.cols,
        rows: options.rows
      },
      10_000,
      signal
    )
    signal?.throwIfAborted()
    if (closed) {
      throw new Error('Usage probe canceled during startup')
    }
    const failure = getFailure()
    if (failure) {
      throw failure
    }
    return {
      pid: result.pid,
      write(data: string) {
        if (!closed && outcome === null && !client.notify('writeTransientPty', { id, data })) {
          fail('Terminal service could not receive usage probe input')
        }
      },
      kill: close,
      destroy: close,
      onData(listener: (data: string) => void) {
        dataListeners.add(listener)
        drain()
        return {
          dispose: () => {
            dataListeners.delete(listener)
          }
        }
      },
      onError(listener: (error: Error) => void) {
        errorListeners.add(listener)
        drain()
        return {
          dispose: () => {
            errorListeners.delete(listener)
          }
        }
      },
      onExit(listener: (event: { exitCode: number }) => void) {
        exitListeners.add(listener)
        drain()
        return {
          dispose: () => {
            exitListeners.delete(listener)
          }
        }
      }
    }
  } catch (error) {
    close()
    throw error
  }
}
