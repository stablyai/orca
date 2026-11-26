// A stand-in Relay cell for tests: one client socket spliced to one host socket with the cell's own
// flow control (cloud/apps/relay/src/connections/splice-forwarder.ts) and its real limits.
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { RELAY_ADMISSION_BUDGETS as LIMITS } from '../../../../../cloud/packages/relay-contract/src/admission-budgets'

type Queued = { data: RawData; binary: boolean; bytes: number }

export type RelayCellStandIn = {
  url: string
  /** Splices closed by the cell's own limits, with why. */
  limitCloses: string[]
  /** Drops every live splice at once, as a cell restart or a network cut does. */
  cut: () => void
  /** Stops the client side reading for a while, as a slow client does. */
  stallClient: (ms: number) => void
  close: () => Promise<void>
}

function frameBytes(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, part) => total + part.byteLength, 0)
    : data.byteLength
}

export async function startRelayCellStandIn(hostUrl: string): Promise<RelayCellStandIn> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 8 * 1024 * 1024 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('stand-in cell has no port')
  }
  const splices = new Set<() => void>()
  const limitCloses: string[] = []
  let clientStalledUntil = 0

  server.on('connection', (client) => {
    const host = new WebSocket(hostUrl, { maxPayload: 8 * 1024 * 1024 })
    let closed = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const close = (limit?: string): void => {
      if (closed) {
        return
      }
      closed = true
      splices.delete(close)
      for (const timer of timers) {
        clearTimeout(timer)
      }
      if (limit) {
        limitCloses.push(limit)
      }
      client.terminate()
      host.terminate()
    }
    splices.add(close)
    const direction = (source: WebSocket, target: WebSocket, toClient: boolean): void => {
      const queue: Queued[] = []
      let queuedBytes = 0
      let wedgedSince: number | null = null
      const flush = (): void => {
        if (closed) {
          return
        }
        const stalled = toClient && Date.now() < clientStalledUntil
        while (
          !stalled &&
          queue.length > 0 &&
          target.bufferedAmount <= LIMITS.spliceLowWaterBytes
        ) {
          const frame = queue.shift()!
          queuedBytes -= frame.bytes
          target.send(frame.data, { binary: frame.binary })
        }
        if (queue.length === 0) {
          wedgedSince = null
          source.resume()
          return
        }
        if (wedgedSince !== null && Date.now() - wedgedSince >= LIMITS.spliceWedgedTimeoutMs) {
          close('wedged')
          return
        }
        const timer = setTimeout(() => {
          timers.delete(timer)
          flush()
        }, 25)
        timers.add(timer)
      }
      source.on('message', (data, binary) => {
        if (closed) {
          return
        }
        const bytes = frameBytes(data)
        const stalled = toClient && Date.now() < clientStalledUntil
        if (
          !stalled &&
          queue.length === 0 &&
          target.readyState === WebSocket.OPEN &&
          target.bufferedAmount <= LIMITS.spliceHighWaterBytes
        ) {
          target.send(data, { binary })
          return
        }
        if (
          queue.length >= LIMITS.spliceHardQueuedFrames ||
          queuedBytes + bytes > LIMITS.spliceHardQueuedBytes
        ) {
          close('queue-limit')
          return
        }
        queue.push({ data, binary, bytes })
        queuedBytes += bytes
        wedgedSince ??= Date.now()
        // The cell pauses the sender's TCP reads to push back on it; ws pauses its socket the same way.
        source.pause()
        if (queue.length === 1) {
          flush()
        }
      })
    }
    // Frames from a client that arrive before the host socket opens wait for it, as at a cell.
    const early: Queued[] = []
    const holdEarly = (data: RawData, binary: boolean): void => {
      early.push({ data, binary, bytes: frameBytes(data) })
    }
    client.on('message', holdEarly)
    host.once('open', () => {
      client.off('message', holdEarly)
      for (const frame of early.splice(0)) {
        host.send(frame.data, { binary: frame.binary })
      }
      direction(client, host, false)
      direction(host, client, true)
    })
    client.once('close', () => close())
    host.once('close', () => close())
    client.once('error', () => close())
    host.once('error', () => close())
  })

  return {
    url: `ws://127.0.0.1:${address.port}`,
    limitCloses,
    cut: () => {
      for (const close of Array.from(splices)) {
        close()
      }
    },
    stallClient: (ms) => {
      clientStalledUntil = Date.now() + ms
    },
    close: async () => {
      for (const close of Array.from(splices)) {
        close()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
