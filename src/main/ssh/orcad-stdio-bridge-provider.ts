/**
 * The managed tunnel's second transport, for hosts whose sshd refuses port forwarding: the same
 * local listener the forward gives, but each accepted socket rides its own exec channel running
 * the stdio bridge. Nothing above the tunnel can tell the two apart.
 *
 * Disconnects match the forward: a lost channel drops its socket and the listener stays, so the
 * tunnel's own reconnect logic decides, and a lost transport never reads as a dead server.
 */
import { createServer, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import { OrcadStdioBridgeUnavailableError } from './orcad-host-unavailable'
import {
  checkOrcadStdioBridge,
  openOrcadStdioBridgeChannel,
  resolveOrcadStdioBridge,
  type OrcadStdioBridge
} from './orcad-stdio-bridge'
import {
  OrcadStdioBridgeBase64Encoder,
  OrcadStdioBridgeDecoder,
  type OrcadStdioBridgeSignal
} from './orcad-stdio-bridge-stream'
import type { SshConnection } from './ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'
import { listenForPortForward } from './ssh2-port-forward-provider'

/**
 * Each bridge is one sshd session, and OpenSSH's MaxSessions defaults to 10 per connection. The
 * client holds one shared control socket and one per stream (terminals, each browser), so 8
 * covers it and leaves room for the exec work sharing the connection. Past it, sockets queue.
 */
export const ORCAD_STDIO_BRIDGE_MAX_CHANNELS = 8
export const ORCAD_STDIO_BRIDGE_QUEUE_TIMEOUT_MS = 30_000

type OrcadStdioBridgeDependencies = {
  resolveBridge: (conn: SshConnection, port: number) => Promise<OrcadStdioBridge>
  checkBridge: (conn: SshConnection, bridge: OrcadStdioBridge) => Promise<unknown>
  openChannel: (conn: SshConnection, bridge: OrcadStdioBridge) => Promise<ClientChannel>
}

const defaultDependencies: OrcadStdioBridgeDependencies = {
  resolveBridge: resolveOrcadStdioBridge,
  checkBridge: checkOrcadStdioBridge,
  openChannel: openOrcadStdioBridgeChannel
}

export class OrcadStdioBridgePortForwardProvider implements SshPortForwardProvider {
  constructor(private readonly dependencies: OrcadStdioBridgeDependencies = defaultDependencies) {}

  // Why not system SSH: each bridge socket would be its own `ssh` process (a fresh login, and
  // perhaps a key prompt, when multiplexing is off), and its refusal can't be probed up front.
  canHandle(conn: SshConnection): boolean {
    return conn.getClient() !== null
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const deps = this.dependencies
    let bridge: Promise<OrcadStdioBridge> | null = null
    // Memoized once it resolves; a failed resolve is retried by the next socket.
    const resolveBridge = (): Promise<OrcadStdioBridge> => {
      bridge ??= deps.resolveBridge(conn, options.remotePort).catch((error: unknown) => {
        bridge = null
        throw error
      })
      return bridge
    }
    try {
      await deps.checkBridge(conn, await resolveBridge())
    } catch (error) {
      if (error instanceof OrcadStdioBridgeUnavailableError) {
        throw error
      }
      // A slow or dropped check is loss of contact; sockets resolve the bridge again.
      console.warn('[ssh] Orca stdio bridge check was unverifiable:', error)
    }

    const sockets = new Set<Socket>()
    const channels = new Set<ClientChannel>()
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
      let resolved: OrcadStdioBridge
      let channel: ClientChannel
      try {
        resolved = await resolveBridge()
        channel = await deps.openChannel(conn, resolved)
      } catch {
        socket.destroy()
        release()
        return
      }
      channel.once('close', release)
      if (closed || socket.destroyed) {
        closeChannel(channel)
        return
      }
      channels.add(channel)
      channel.once('close', () => channels.delete(channel))
      pipeSocketThroughBridge(socket, channel, resolved.mode)
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
}

function pipeSocketThroughBridge(
  socket: Socket,
  channel: ClientChannel,
  mode: OrcadStdioBridge['mode']
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

function closeChannel(channel: ClientChannel): void {
  try {
    channel.close()
  } catch {
    // Late callbacks after the transport dropped.
  }
}
