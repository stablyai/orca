import type { AcpAgentConnection } from './acp-agent-connection'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'

export type AcpDiscoveryConnection = Pick<
  AcpAgentConnection,
  'initialize' | 'start' | 'subscribe' | 'close' | 'onExit' | 'rootVerdict' | 'lastCloseResult'
>

/** Cancellation stops ownership waits; continuations must still check before effects. */
export async function awaitAcpDiscovery<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = () => rejectAbort(signal.reason)
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  signal.addEventListener('abort', aborted, { once: true })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}

/** Availability can answer before managed teardown; its owner must retain completion. */
export function runAcpSessionDiscovery<T>(
  connection: AcpDiscoveryConnection,
  signal: AbortSignal,
  body: (check: () => void) => Promise<T>
): {
  answer: Promise<T>
  completion: Promise<{ result: ProviderProcessCloseResult | null; error?: unknown }>
} {
  let closing = false
  const check = () => {
    signal.throwIfAborted()
    if (closing) {
      throw new Error('ACP discovery closed')
    }
  }
  const answer = awaitAcpDiscovery(
    Promise.resolve().then(() => {
      check()
      return body(check)
    }),
    signal
  )
  const completion = answer
    .then(
      () => {},
      () => {}
    )
    .then(async () => {
      closing = true
      try {
        await connection.close()
        return { result: connection.lastCloseResult }
      } catch (error) {
        return { result: connection.lastCloseResult, error }
      }
    })
  return { answer, completion }
}
