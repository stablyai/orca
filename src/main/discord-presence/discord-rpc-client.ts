import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiscordActivity } from './discord-presence-activity'

const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_PING = 3
const OP_PONG = 4

/** Discord closed the socket after receiving our handshake — almost always an invalid client_id. Retrying will not help. */
export class DiscordHandshakeRejectedError extends Error {
  constructor() {
    super('Discord rejected the handshake — check your client_id (ORCA_DISCORD_CLIENT_ID)')
    this.name = 'DiscordHandshakeRejectedError'
  }
}

export interface DiscordRpcClient {
  connect(): Promise<void>
  setActivity(activity: DiscordActivity | null): Promise<void>
  disconnect(): void
  onDisconnect(cb: () => void): void
}

function discoverPipePath(index: number): string {
  const pipeName = `discord-ipc-${index}`
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\${pipeName}`
  }
  // macOS / Linux: Unix socket
  const dir = process.platform === 'darwin'
    ? (process.env.TMPDIR || '/tmp')
    : (process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`)
  return path.join(dir, pipeName)
}

function encodeFrame(opcode: number, payload: string): Buffer {
  const jsonBuffer = Buffer.from(payload, 'utf-8')
  const header = Buffer.alloc(8)
  header.writeInt32LE(opcode, 0)
  header.writeInt32LE(jsonBuffer.length, 4)
  return Buffer.concat([header, jsonBuffer])
}

function decodeFrame(buf: Buffer): { opcode: number; payload: string } | null {
  if (buf.length < 8) return null
  const opcode = buf.readInt32LE(0)
  const length = buf.readInt32LE(4)
  if (buf.length < 8 + length) return null
  return { opcode, payload: buf.subarray(8, 8 + length).toString('utf-8') }
}

type SocketLike = {
  connect(opts: Record<string, unknown>, cb?: () => void): void
  on(event: string, cb: (...args: unknown[]) => void): void
  removeListener(event: string, cb: (...args: unknown[]) => void): void
  write(data: Uint8Array | string, cb?: (err?: Error) => void): boolean
  destroy(): void
  removeAllListeners(event?: string): void
}

export function createDiscordRpcClient(
  clientId: string,
  createSocket?: () => SocketLike
): DiscordRpcClient {
  const pid = process.pid
  let socket: SocketLike | null = null
  let disconnectCb: (() => void) | null = null
  let buffer = Buffer.alloc(0)
  let pendingRequests = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

  function makeSocket(): SocketLike {
    if (createSocket) return createSocket()
    return new net.Socket() as unknown as SocketLike
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let pipeIndex = 0

      function tryConnect() {
        if (pipeIndex > 9) {
          reject(new Error('Discord IPC not found (tried pipes 0-9)'))
          return
        }

        socket = makeSocket()
        const pipePath = discoverPipePath(pipeIndex)
        let settled = false

        const onError = (..._args: unknown[]) => {
          if (settled) return
          settled = true
          socket!.removeAllListeners()
          socket = null
          pipeIndex++
          tryConnect()
        }

        socket.on('error', onError)

        socket.connect({ path: pipePath }, () => {
          if (settled) return
          settled = true
          socket!.removeListener('error', onError)
          performHandshake(resolve, reject)
        })
      }

      function performHandshake(resolve: (v: void) => void, reject: (err: Error) => void) {
        if (!socket) return

        const onError = (..._args: unknown[]) => {
          reject(_args[0] as Error)
        }
        socket.on('error', onError)
        socket.on('close', (..._args: unknown[]) => {
          reject(new DiscordHandshakeRejectedError())
        })

        let handshakeData = Buffer.alloc(0)
        socket.on('data', (chunk: unknown) => {
          handshakeData = Buffer.concat([handshakeData, chunk as Buffer])
          const frame = decodeFrame(handshakeData)
          if (!frame) return

          if (frame.opcode === OP_FRAME) {
            try {
              const msg = JSON.parse(frame.payload)
              if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
                socket!.removeListener('error', onError)
                socket!.removeAllListeners('close')
                setupDataHandler()
                resolve()
              }
            } catch { /* malformed, keep waiting */ }
          }
        })

        const hsFrame = encodeFrame(OP_HANDSHAKE, JSON.stringify({ v: 1, client_id: clientId }))
        socket.write(hsFrame)
      }

      tryConnect()
    })
  }

  function setupDataHandler() {
    if (!socket) return
    socket.removeAllListeners('data')
    buffer = Buffer.alloc(0)

    socket.on('data', (chunk: unknown) => {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      while (buffer.length >= 8) {
        const opcode = buffer.readInt32LE(0)
        const length = buffer.readInt32LE(4)
        if (buffer.length < 8 + length) break

        const payload = buffer.subarray(8, 8 + length).toString('utf-8')
        buffer = buffer.subarray(8 + length)

        if (opcode === OP_PING) {
          socket!.write(encodeFrame(OP_PONG, payload))
        } else if (opcode === OP_FRAME) {
          try {
            const msg = JSON.parse(payload)
            if (msg.nonce && pendingRequests.has(msg.nonce)) {
              pendingRequests.get(msg.nonce)!.resolve()
              pendingRequests.delete(msg.nonce)
            }
          } catch { /* ignore malformed */ }
        }
      }
    })

    socket.on('close', (..._args: unknown[]) => {
      for (const { reject } of pendingRequests.values()) {
        reject(new Error('Disconnected'))
      }
      pendingRequests.clear()
      disconnectCb?.()
    })
  }

  function setActivity(activity: DiscordActivity | null): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error('Not connected'))
        return
      }
      const nonce = randomUUID()
      pendingRequests.set(nonce, { resolve, reject })

      const args: Record<string, unknown> = { pid }
      if (activity !== null) {
        args.activity = activity
      }
      const frame = encodeFrame(OP_FRAME, JSON.stringify({
        cmd: 'SET_ACTIVITY',
        args,
        nonce
      }))
      socket.write(frame)
    })
  }

  function disconnect() {
    for (const { reject } of pendingRequests.values()) {
      reject(new Error('Disconnected'))
    }
    pendingRequests.clear()
    if (socket) {
      socket.destroy()
      socket = null
    }
    disconnectCb?.()
  }

  function onDisconnect(cb: () => void) {
    disconnectCb = cb
  }

  return { connect, setActivity, disconnect, onDisconnect }
}