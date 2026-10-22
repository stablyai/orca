/**
 * The local half of the stdio bridge: a loopback listener whose every accepted socket rides its
 * own bridge channel from a channel factory. Owns admission, queueing and teardown; knows nothing
 * of the host transport the channels run over.
 */
import { createServer, type Socket } from 'node:net'
import type { OrcadStdioBridgeMode } from './orcad-stdio-bridge-script'
import {
  OrcadStdioBridgeBase64Encoder,
  OrcadStdioBridgeDecoder,
  type OrcadStdioBridgeSignal
} from './orcad-stdio-bridge-stream'
import type { RemoteCommandChannel } from '../install/remote-install-transport'
import type {
  PortForwardStartOptions,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { listenForPortForward } from '../../ssh/port-forwarding/ssh2-port-forward-provider'

/**
 * Each bridge is one sshd session, and OpenSSH's MaxSessions defaults to 10 per connection. The
 * client holds one shared control socket and one per stream (terminals, each browser), so 8
 * covers it and leaves room for the exec work sharing the connection. Past it, sockets queue.
 */
export const ORCAD_STDIO_BRIDGE_MAX_CHANNELS = 8
const ORCAD_STDIO_BRIDGE_QUEUE_TIMEOUT_MS = 30_000

/** Opens one bridge channel for one accepted socket; a rejection just drops that socket. */
type OrcadStdioBridgeChannelFactory = () => Promise<{
  channel: RemoteCommandChannel
  mode: OrcadStdioBridgeMode
}>

export async function listenOrcadStdioBridge(
  options: PortForwardStartOptions,
  openChannel: OrcadStdioBridgeChannelFactory
): Promise<StartedPortForward> {
  const sockets = new Set<Socket>()
  const channels = new Set<RemoteCommandChannel>()
  const waiting: { socket: Socket; timer: ReturnType<typeof setTimeout> }[] = []
  let open = 0
  let closed = false

  const admitNext = (): void => {
    while (open < ORCAD_STDIO_BRIDGE_MAX_CHANNELS) {
      const next = waiting.shift()
      if (!next) {
        return
      }
      clearTimeout(next.timer)
      void bridgeSocket(next.socket)
    }
  }
  const release = (): void => {
    open -= 1
    admitNext()
  }

  const bridgeSocket = async (socket: Socket): Promise<void> => {
    if (closed || socket.destroyed) {
      return
    }
    open += 1
    let opened: Awaited<ReturnType<OrcadStdioBridgeChannelFactory>>
    try {
      opened = await openChannel()
    } catch {
      socket.destroy()
      release()
      return
    }
    const { channel, mode } = opened
    channel.once('close', release)
    if (closed || socket.destroyed) {
      closeChannel(channel)
      return
    }
    channels.add(channel)
    channel.once('close', () => channels.delete(channel))
    pipeSocketThroughBridge(socket, channel, mode)
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    const entry = {
      socket,
      timer: setTimeout(() => socket.destroy(), ORCAD_STDIO_BRIDGE_QUEUE_TIMEOUT_MS)
    }
    socket.on('close', () => {
      sockets.delete(socket)
      clearTimeout(entry.timer)
      const index = waiting.indexOf(entry)
      if (index !== -1) {
        waiting.splice(index, 1)
      }
    })
    waiting.push(entry)
    admitNext()
  })

  await listenForPortForward(server, options.localHost, options.localPort)
  const address = server.address()
  const localPort = typeof address === 'object' && address ? address.port : options.localPort
  const entry = {
    id: options.id,
    connectionId: options.connectionId,
    localPort,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    label: options.label
  }

  const close = (): Promise<void> => {
    if (closed) {
      return Promise.resolve()
    }
    closed = true
    for (const { timer } of waiting.splice(0)) {
      clearTimeout(timer)
    }
    for (const channel of channels) {
      closeChannel(channel)
    }
    for (const socket of sockets) {
      socket.destroy()
    }
    return new Promise((resolve) => server.close(() => resolve()))
  }
  return { entry, close, dispose: () => void close() }
}

function pipeSocketThroughBridge(
  socket: Socket,
  channel: RemoteCommandChannel,
  mode: OrcadStdioBridgeMode
): void {
  const decoder = new OrcadStdioBridgeDecoder(mode)
  // A refused dial is what the forward's failed channel open is: the socket just closes.
  decoder.once('signal', (signal: OrcadStdioBridgeSignal) => {
    if (signal !== 'ready') {
      socket.destroy()
      closeChannel(channel)
    }
  })
  decoder.on('error', () => {
    socket.destroy()
    closeChannel(channel)
  })
  channel.pipe(decoder).pipe(socket)
  if (mode === 'base64') {
    socket.pipe(new OrcadStdioBridgeBase64Encoder()).pipe(channel)
  } else {
    socket.pipe(channel)
  }
  channel.stderr.resume()
  channel.on('error', () => socket.destroy())
  channel.on('close', () => {
    if (!socket.writableEnded) {
      socket.destroy()
    }
  })
  socket.on('close', () => closeChannel(channel))
}

function closeChannel(channel: RemoteCommandChannel): void {
  try {
    channel.close()
  } catch {
    // Late callbacks after the transport dropped.
  }
}
