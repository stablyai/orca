// Accept side of the iroh transport: drain incoming connections, apply the
// capacity cap, and hand each accepted bi-stream to the connection handler.
import type { BiStream, Connection, Endpoint, Incoming } from '@number0/iroh'
import { connectionPathKind, remoteIdPrefix } from './iroh-connection-log'
import { IrohFramedSocket } from './iroh-framed-socket'

const ACCEPT_RETRY_DELAY_MS = 1_000
// Why: until acceptBi resolves no socket exists, so the pre-auth reaper can't
// see the connection — bound the wait ourselves.
const ACCEPT_BI_TIMEOUT_MS = 10_000

type IrohAcceptLoopOptions = {
  endpoint: Endpoint
  signal: AbortSignal
  connections: Set<Connection>
  atCapacity: (pending: number) => boolean
  onConnection: (socket: IrohFramedSocket, bi: BiStream) => void
}

/** Accept until shutdown, counting pending handshakes toward the admission limit. */
export async function runIrohAcceptLoop(args: IrohAcceptLoopOptions): Promise<void> {
  let pending = 0
  while (!args.signal.aborted) {
    let incoming: Incoming | null
    try {
      incoming = await args.endpoint.acceptNext()
    } catch (error) {
      if (args.signal.aborted) {
        break
      }
      // Why: a silently dead accept loop leaves QRs advertising an endpoint
      // that accepts nothing — log and retry instead of giving up.
      console.warn(
        `[iroh-transport] acceptNext failed, retrying: ${error instanceof Error ? error.message : String(error)}`
      )
      const retry = Promise.withResolvers<void>()
      const timer = setTimeout(retry.resolve, ACCEPT_RETRY_DELAY_MS)
      timer.unref?.()
      const onStop = (): void => retry.resolve()
      args.signal.addEventListener('abort', onStop, { once: true })
      await retry.promise
      clearTimeout(timer)
      args.signal.removeEventListener('abort', onStop)
      continue
    }
    if (!incoming) {
      break
    }
    if (args.signal.aborted) {
      await incoming.refuse().catch(() => {})
      break
    }
    if (args.atCapacity(pending)) {
      await incoming.refuse().catch(() => {})
      continue
    }
    // Reserve before native handshakes or acceptBi can stall without a socket.
    pending += 1
    void acceptConnection(incoming, args).finally(() => {
      pending -= 1
    })
  }
}

/** Hand off one bi-stream, closing any connection that fails or outlives shutdown. */
async function acceptConnection(incoming: Incoming, args: IrohAcceptLoopOptions): Promise<void> {
  let connection: Connection | null = null
  let handedOff = false
  try {
    // The qualified SDK closes connect() natively after 10s. A JS timeout cannot
    // cancel it, so retain this admission until native completion; close late shutdown results.
    connection = await (await incoming.accept()).connect()
    if (args.signal.aborted) {
      connection.close(0n, [])
      return
    }
    args.connections.add(connection)
    const remotePrefix = remoteIdPrefix(connection)
    const kind = connectionPathKind(connection)
    console.info(`[iroh-transport] connection accepted remote=${remotePrefix} kind=${kind}`)
    // Why: dialing side (phone) opens the single long-lived bi-stream.
    const bi = await acceptBiWithTimeout(connection, args.signal)
    if (!bi || args.signal.aborted) {
      return
    }
    args.onConnection(new IrohFramedSocket(bi, connection), bi)
    handedOff = true
  } catch (error) {
    if (!args.signal.aborted) {
      console.warn(
        `[iroh-transport] accept failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  } finally {
    if (connection) {
      const owned = args.connections.delete(connection)
      if (!handedOff && owned) {
        try {
          connection.close(0n, [])
        } catch {
          // Already closed.
        }
      }
    }
  }
}

/** Bound the peer's first-stream wait; shutdown resolves null and releases the timer. */
async function acceptBiWithTimeout(
  connection: Connection,
  signal: AbortSignal
): Promise<BiStream | null> {
  const accepted = Promise.withResolvers<BiStream | null>()
  const timer = setTimeout(
    () => accepted.reject(new Error('bi-stream not opened within accept timeout')),
    ACCEPT_BI_TIMEOUT_MS
  )
  timer.unref?.()
  const onStop = (): void => accepted.resolve(null)
  signal.addEventListener('abort', onStop, { once: true })
  try {
    void connection.acceptBi().then(accepted.resolve, accepted.reject)
    return await accepted.promise
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onStop)
  }
}
