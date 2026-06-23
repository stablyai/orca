import { connect, type Socket as NetSocket } from 'net'
import { Socks5ConnectClient, type Socks5Result } from './socks5-connect-codec'

export type TailscaleSocksProxy = { host: string; port: number }

export type TailscaleDialOptions = {
  /** Abort the dial if the SOCKS5 handshake has not completed in this window. */
  timeoutMs?: number
}

const DEFAULT_DIAL_TIMEOUT_MS = 30_000
const EMPTY = Buffer.alloc(0)

// Why: thin imperative shell over the sans-I/O Socks5ConnectClient. It performs
// the CONNECT handshake against the tailnet sidecar's loopback SOCKS5 proxy and
// hands ssh2 a socket already tunneled to the destination, so the rest of the
// connection path is identical to a direct dial (config.sock).
//
// The handshake runs in paused mode ('readable' + read()), never flowing. That
// matters for the handoff: any bytes the proxy sends after the reply are pushed
// back with unshift() and must survive until ssh2 attaches its own reader. A
// flowing socket would emit those bytes to nobody once our listener is removed.
export function dialThroughSocks5(
  proxy: TailscaleSocksProxy,
  destHost: string,
  destPort: number,
  options: TailscaleDialOptions = {}
): Promise<NetSocket> {
  return new Promise((resolve, reject) => {
    const client = new Socks5ConnectClient(destHost, destPort)
    const socket = connect(proxy.port, proxy.host)
    socket.setNoDelay(true)

    let settled = false
    const timeoutMs = options.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS
    const timer = setTimeout(() => {
      fail(new Error(`SOCKS5 handshake to ${destHost}:${destPort} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    function cleanup(): void {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('readable', onReadable)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    function fail(err: Error): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      socket.destroy()
      reject(err)
    }

    function succeed(leftover: Buffer): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (leftover.length > 0) {
        socket.unshift(leftover)
      }
      resolve(socket)
    }

    // Feed a chunk to the codec and flush any request bytes it asks us to send,
    // re-driving it on the buffered remainder. This keeps a server that pipelines
    // the reply onto method selection from stalling.
    function pump(chunk: Buffer): Socks5Result {
      let result = client.receive(chunk)
      while (result.status === 'send') {
        socket.write(result.data)
        result = client.receive(EMPTY)
      }
      return result
    }

    function onConnect(): void {
      socket.write(client.greeting())
    }

    function onReadable(): void {
      let chunk: Buffer | null
      while ((chunk = socket.read()) !== null) {
        const result = pump(chunk)
        if (result.status === 'connected') {
          succeed(result.leftover)
          return
        }
        if (result.status === 'error') {
          fail(result.error)
          return
        }
        // need-more: drained for now; wait for the next 'readable'.
      }
    }

    function onError(err: Error): void {
      fail(err)
    }

    function onClose(): void {
      fail(
        new Error(
          `SOCKS5 proxy closed the connection before the handshake to ${destHost}:${destPort} completed`
        )
      )
    }

    socket.on('connect', onConnect)
    socket.on('readable', onReadable)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}
