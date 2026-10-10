import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import {
  DISCORD_IPC_OPCODE,
  DiscordIpcPacketDecoder,
  encodeDiscordIpcPacket,
  type DiscordIpcPacket
} from './discord-ipc-packet'

const HANDSHAKE_TIMEOUT_MS = 5_000

/** The subset of Discord's activity object Orca sends; see docs.discord.com/developers/events/gateway-events. */
export type DiscordActivity = {
  type: 0
  details?: string
  state?: string
  timestamps?: { start?: number }
  assets?: { large_image?: string; large_text?: string }
}

export type DiscordIpcConnection = {
  setActivity: (activity: DiscordActivity | null) => void
  close: () => void
}

export type DiscordIpcConnectOptions = {
  clientId: string
  socketPaths: readonly string[]
  pid: number
  /** Fires once when an established connection ends for any reason. */
  onClosed: () => void
}

type Logger = Pick<Console, 'debug' | 'warn'>

function readEvent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('evt' in payload)) {
    return null
  }
  return typeof payload.evt === 'string' ? payload.evt : null
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const onError = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

function handshake(socket: Socket, clientId: string, decoder: DiscordIpcPacketDecoder) {
  return new Promise<DiscordIpcPacket[]>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      let packets: DiscordIpcPacket[]
      try {
        packets = decoder.push(chunk)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (packets.some((packet) => packet.op === DISCORD_IPC_OPCODE.close)) {
        // Why: Discord answers a rejected handshake (e.g. unknown client id, 4000) with CLOSE.
        fail(new Error('discord closed the handshake'))
        return
      }
      const readyIndex = packets.findIndex(
        (packet) => packet.op === DISCORD_IPC_OPCODE.frame && readEvent(packet.payload) === 'READY'
      )
      if (readyIndex !== -1) {
        cleanup()
        resolve(packets.slice(readyIndex + 1))
      }
    }
    const onClose = (): void => fail(new Error('discord ipc closed during handshake'))
    const onError = (error: Error): void => fail(error)
    const timer = setTimeout(
      () => fail(new Error('discord ipc handshake timed out')),
      HANDSHAKE_TIMEOUT_MS
    )
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.once('error', onError)
    socket.write(
      encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.handshake, { v: 1, client_id: clientId })
    )
  })
}

async function connectToPath(
  path: string,
  options: DiscordIpcConnectOptions,
  logger: Logger
): Promise<DiscordIpcConnection> {
  const socket = await openSocket(path)
  const decoder = new DiscordIpcPacketDecoder()
  let backlog: DiscordIpcPacket[]
  try {
    backlog = await handshake(socket, options.clientId, decoder)
  } catch (error) {
    socket.destroy()
    throw error
  }

  let closed = false
  const markClosed = (): void => {
    if (closed) {
      return
    }
    closed = true
    socket.destroy()
    options.onClosed()
  }
  const handlePacket = (packet: DiscordIpcPacket): void => {
    if (packet.op === DISCORD_IPC_OPCODE.ping) {
      socket.write(encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.pong, packet.payload))
    } else if (packet.op === DISCORD_IPC_OPCODE.close) {
      markClosed()
    } else if (readEvent(packet.payload) === 'ERROR') {
      logger.debug('[discord-presence] discord rejected a command', packet.payload)
    }
  }
  socket.on('data', (chunk: Buffer) => {
    try {
      decoder.push(chunk).forEach(handlePacket)
    } catch (error) {
      logger.warn('[discord-presence] dropping corrupt ipc stream', error)
      markClosed()
    }
  })
  socket.on('error', () => markClosed())
  socket.on('close', () => markClosed())
  backlog.forEach(handlePacket)

  return {
    setActivity: (activity) => {
      if (closed) {
        return
      }
      // Why: omitting `activity` is how Discord's own clients clear presence.
      const args = activity ? { pid: options.pid, activity } : { pid: options.pid }
      socket.write(
        encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.frame, {
          cmd: 'SET_ACTIVITY',
          args,
          nonce: randomUUID()
        })
      )
    },
    close: () => {
      if (closed) {
        return
      }
      closed = true
      // Why: end() flushes a pending clear-activity write before the pipe goes away.
      socket.end(encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.close, {}))
    }
  }
}

/** Connects to the first Discord client that accepts the handshake; rejects when none is reachable. */
export async function connectDiscordIpc(
  options: DiscordIpcConnectOptions,
  logger: Logger = console
): Promise<DiscordIpcConnection> {
  // Why: a non-snowflake id is always rejected, so skip probing every socket for nothing.
  if (!/^\d+$/.test(options.clientId)) {
    throw new Error('discord client id is not configured')
  }
  let lastError: unknown = new Error('no discord ipc socket paths')
  for (const path of options.socketPaths) {
    try {
      return await connectToPath(path, options, logger)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
