import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserNetworkTunnelClient } from '../../browser/network/tunnels/browser-network-tunnel-client'
import { BrowserNetworkTunnelSession } from '../../browser/network/tunnels/browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { createAuthCallbackDialer } from '../../runtime/rpc/methods/accounts/auth-callback-tunnel'
import { AuthCallbackForward, type AuthCallbackTunnelOpener } from './auth-callback-forward'

// Past one flow-control window, so the reply only finishes if the forward returns credit.
const REPLY_BYTES = 600 * 1024

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** The host side in-process: a tunnel session whose dialer reaches the stand-in login. */
function inProcessTunnel(port: number, loginPort: number): AuthCallbackTunnelOpener {
  return async (onClosed) => {
    let session: BrowserNetworkTunnelSession | null = null
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 1,
      sendBinary: (bytes) => {
        queueMicrotask(() => session?.handleBinary(bytes))
        return true
      },
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
      onClosed
    })
    session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 1,
      connect: createAuthCallbackDialer(
        port,
        () => {},
        () => connect(loginPort, '127.0.0.1')
      ),
      sendBinary: (bytes) => {
        queueMicrotask(() => client.handleBinary(bytes))
        return true
      },
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL
    })
    return { client, close: () => client.close() }
  }
}

describe('AuthCallbackForward', () => {
  it('delivers a reply larger than one flow-control window to the browser', async () => {
    const login = createServer((socket: Socket) => {
      socket.once('data', () => socket.end(Buffer.alloc(REPLY_BYTES, 1)))
    })
    const loginPort = await listen(login)
    cleanups.push(() => login.close())
    const port = await freePort()
    const forward = new AuthCallbackForward(
      { environmentId: 'env', flowId: 'flow', port },
      () => {}
    )
    cleanups.push(() => forward.close())
    await expect(forward.start(inProcessTunnel(port, loginPort))).resolves.toEqual({ ok: true })

    const received = await new Promise<number>((resolve, reject) => {
      const browser = connect(port, '127.0.0.1', () =>
        browser.write('GET /callback HTTP/1.1\r\n\r\n')
      )
      let bytes = 0
      browser.on('data', (chunk) => {
        bytes += chunk.byteLength
      })
      browser.on('end', () => resolve(bytes))
      browser.on('error', reject)
    })
    expect(received).toBe(REPLY_BYTES)
  })
})
