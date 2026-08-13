import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createDiscordRpcClient } from './discord-rpc-client'
import type { DiscordActivity } from './discord-presence-activity'

const OP_FRAME = 1

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

const CLIENT_ID = '123456789012345678'

// Synchronous mock socket — .connect() calls cb immediately
class SyncSocket extends EventEmitter {
  written: Buffer[] = []
  destroyed = false

  connect(_opts: Record<string, unknown>, cb?: () => void) {
    if (cb) cb()
    return this
  }

  write(data: Uint8Array | string, cb?: (err?: Error) => void): boolean {
    this.written.push(Buffer.from(data))
    if (cb) cb()
    return true
  }

  destroy() {
    this.destroyed = true
    return this
  }

  removeAllListeners(event?: string) {
    super.removeAllListeners(event)
    return this
  }

  feedHandshakeAck() {
    this.emit('data', encodeFrame(OP_FRAME, JSON.stringify({
      cmd: 'DISPATCH', evt: 'READY', data: { user: { id: '1' } }
    })))
  }

  feedActivityAck(nonce: string) {
    this.emit('data', encodeFrame(OP_FRAME, JSON.stringify({ cmd: 'SET_ACTIVITY', nonce })))
  }

  lastPayload(): string | null {
    if (this.written.length === 0) return null
    const buf = Buffer.concat(this.written)
    const frame = decodeFrame(buf)
    return frame?.payload ?? null
  }
}

// Socket that always errors before the connect callback fires (pipe not found)
class FailSocket extends EventEmitter {
  connect(_opts: Record<string, unknown>, _cb?: () => void) {
    process.nextTick(() => this.emit('error', new Error('ENOENT')))
    return this
  }
  write(_data: Uint8Array | string, cb?: (err?: Error) => void): boolean {
    if (cb) cb()
    return true
  }
  destroy() { return this }
  removeAllListeners(event?: string) {
    super.removeAllListeners(event)
    return this
  }
}

describe('createDiscordRpcClient', () => {
  it('connect() sends handshake and resolves on ACK', async () => {
    const sock = new SyncSocket()
    const client = createDiscordRpcClient(CLIENT_ID, () => sock)

    const promise = client.connect()
    sock.feedHandshakeAck()
    await expect(promise).resolves.toBeUndefined()

    const payload = sock.lastPayload()
    expect(payload).not.toBeNull()
    const parsed = JSON.parse(payload!)
    expect(parsed).toEqual({ v: 1, client_id: CLIENT_ID })
  })

  it('setActivity() sends SET_ACTIVITY frame', async () => {
    const sock = new SyncSocket()
    const client = createDiscordRpcClient(CLIENT_ID, () => sock)

    const cp = client.connect()
    sock.feedHandshakeAck()
    await cp
    sock.written = []

    const activity: DiscordActivity = {
      details: '1 agent working',
      state: 'Claude',
      assets: { large_image: 'orca', large_text: 'Orca' }
    }

    const sp = client.setActivity(activity)
    const payload = JSON.parse(sock.lastPayload()!)
    expect(payload.cmd).toBe('SET_ACTIVITY')
    expect(payload.nonce).toBeTypeOf('string')
    expect(payload.args.activity).toEqual(activity)

    sock.feedActivityAck(payload.nonce)
    await expect(sp).resolves.toBeUndefined()
  })

  it('setActivity(null) clears presence', async () => {
    const sock = new SyncSocket()
    const client = createDiscordRpcClient(CLIENT_ID, () => sock)

    const cp = client.connect()
    sock.feedHandshakeAck()
    await cp
    sock.written = []

    void client.setActivity(null)
    const payload = JSON.parse(sock.lastPayload()!)
    expect(payload.cmd).toBe('SET_ACTIVITY')
    expect(payload.args.activity).toBeUndefined()
  })

  it('disconnect() destroys socket and notifies onDisconnect', async () => {
    const sock = new SyncSocket()
    const client = createDiscordRpcClient(CLIENT_ID, () => sock)

    // Connect first so there is an active socket
    const cp = client.connect()
    sock.feedHandshakeAck()
    await cp

    const cb = vi.fn()
    client.onDisconnect(cb)

    client.disconnect()
    expect(sock.destroyed).toBe(true)
    expect(cb).toHaveBeenCalled()
  })

  it('connect() rejects on error during handshake', async () => {
    const sock = new SyncSocket()
    const client = createDiscordRpcClient(CLIENT_ID, () => sock)

    const promise = client.connect()
    sock.emit('error', new Error('ECONNREFUSED'))
    await expect(promise).rejects.toThrow('ECONNREFUSED')
  })

  it('connect() rejects when all IPC pipes are unavailable', async () => {
    let created = 0
    const client = createDiscordRpcClient(CLIENT_ID, () => {
      created++
      return new FailSocket()
    })
    await expect(client.connect()).rejects.toThrow('Discord IPC not found (tried pipes 0-9)')
    expect(created).toBe(10)
  })
})