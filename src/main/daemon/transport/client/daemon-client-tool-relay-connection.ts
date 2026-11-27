import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { DaemonProtocolError } from '../../protocol/daemon-errors'
import { TOOL_RELAY_HELLO_ROLE } from '../../protocol/daemon-tool-relay-front-protocol'
import { sendDaemonHello } from './daemon-client-hello-handshake'
import type { DaemonClient } from './daemon-client'

const CONNECT_TIMEOUT_MS = 5_000

/**
 * The app's own authenticated connection for one held tool relay front connection. Opened only for
 * a client already connected, whose socket folder its control connect checked (private and ours).
 * What the daemon splices in follows the hello, so the socket comes back paused with any bytes read.
 */
export async function openDaemonToolRelayConnection(
  client: Pick<DaemonClient, 'socketPath' | 'tokenPath' | 'protocolVersion' | 'clientId'>,
  frontConnectionId: string
): Promise<{ socket: Socket; remainder: Buffer }> {
  const token = (await readFile(client.tokenPath, 'utf8')).trim()
  const socket = await new Promise<Socket>((resolve, reject) => {
    const pending = connect(client.socketPath)
    const timer = setTimeout(() => {
      pending.destroy()
      reject(new DaemonProtocolError('Connection timed out'))
    }, CONNECT_TIMEOUT_MS)
    pending.once('connect', () => {
      clearTimeout(timer)
      resolve(pending)
    })
    pending.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  try {
    const hello = await sendDaemonHello({
      socket,
      token,
      protocolVersion: client.protocolVersion,
      clientId: client.clientId,
      role: TOOL_RELAY_HELLO_ROLE,
      frontConnectionId,
      timeoutMs: CONNECT_TIMEOUT_MS
    })
    return { socket, remainder: hello.remainder }
  } catch (error) {
    socket.destroy()
    throw error
  }
}
