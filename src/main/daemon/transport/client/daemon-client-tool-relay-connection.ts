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
  frontConnectionId: string,
  /** Aborting ends the setup and its socket, whatever step it is at. */
  signal?: AbortSignal
): Promise<{ socket: Socket; remainder: Buffer }> {
  signal?.throwIfAborted()
  const token = (await readFile(client.tokenPath, 'utf8')).trim()
  signal?.throwIfAborted()
  const socket = connect(client.socketPath)
  const onAbort = (): void => {
    socket.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new DaemonProtocolError('Connection timed out'))
      }, CONNECT_TIMEOUT_MS)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('close', () => {
        clearTimeout(timer)
        reject(new DaemonProtocolError('Connection closed'))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    signal?.throwIfAborted()
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
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
