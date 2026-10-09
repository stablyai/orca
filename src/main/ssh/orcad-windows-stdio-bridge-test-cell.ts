/**
 * The Windows host lane's stdio bridge cell: the lane's sshd refuses forwarding for the orcad
 * cells' accounts, so the managed tunnel must choose the bridge and reach the live orcad over it.
 */
import { connect } from 'node:net'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from './orcad-remote-readiness-wait'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import type { SshConnection } from './ssh-connection'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { probeTcpForwarding } from './ssh-tcp-forwarding-probe'

const RESPONSE_TIMEOUT_MS = 60_000

/** A WebSocket upgrade through the tunnel: orcad's server answers that with no client auth. */
function firstResponseLine(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('No HTTP response through the stdio bridge'))
    }, RESPONSE_TIMEOUT_MS)
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1')
      const end = received.indexOf('\r\n')
      if (end !== -1) {
        clearTimeout(timer)
        socket.destroy()
        resolve(received.slice(0, end))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.write(
      [
        'GET / HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n')
    )
  })
}

export async function proveWindowsStdioBridge(
  conn: SshConnection,
  host: RemoteHostPlatform,
  slotDir: string
): Promise<{ forwarding: string; response: string }> {
  const parsed = parseOrcadReadinessWaitOutput(
    host,
    await execOrcadRemote({ conn, host }, readOrcadReadinessNowCommand(host, slotDir))
  )
  if (parsed.state !== 'ready' || !parsed.readiness.boundEndpoint) {
    throw new Error(`The active orcad published no endpoint: ${JSON.stringify(parsed)}`)
  }
  const remotePort = Number(new URL(parsed.readiness.boundEndpoint).port)
  const forwarding = await probeTcpForwarding(conn, remotePort)
  const tunnel = await new OrcadManagedTunnelTransportProvider().start(conn, {
    id: 'stdio-bridge-cell',
    connectionId: 'stdio-bridge-cell',
    localHost: '127.0.0.1',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort
  })
  try {
    return { forwarding, response: await firstResponseLine(tunnel.entry.localPort) }
  } finally {
    await tunnel.close()
  }
}
