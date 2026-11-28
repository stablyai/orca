import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { RexDataStream } from './rex-data-stream'
import { rexDataReceiveBudget, rexDataWireBudget } from './rex-memory-budget'

describe.skipIf(process.platform === 'win32')('Rex data stream reconnect', () => {
  const cases = ['valid', 'wrong-nonce', 'close-during-resume', 'concurrent-read'] as const
  it.each(cases)('exact offset and single reader lifetime: %s', async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-data-test-'))
    const path = join(dir, 's')
    const server = createServer()
    const wss = new WebSocketServer({ server })
    let stream: RexDataStream | undefined
    const token = Buffer.alloc(16, 11)
    const ticket = Buffer.alloc(16, 22)
    const hello = Buffer.concat([Buffer.from([1]), ticket])
    const envelope = Buffer.alloc(20)
    envelope.write('GHOSTSNP')
    envelope.writeUInt16LE(1, 8)
    envelope.writeUInt16LE(6, 10)
    const first = Buffer.concat([envelope, Buffer.from('abc')])
    let resume: Buffer | undefined
    let connections = 0
    let resumePeer: WebSocket | undefined
    let resumeAck: Buffer | undefined
    wss.on('connection', (socket) => {
      connections++
      const attempt = connections
      socket.once('message', (raw) => {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.alloc(0)
        const ack = Buffer.alloc(32)
        ack[0] = 0x81
        token.copy(ack, 1)
        ack.writeUInt32LE(60000, 20)
        ack.writeBigUInt64LE(attempt === 2 && mode === 'wrong-nonce' ? 43n : 42n, 24)
        if (attempt === 1) {
          expect(data).toEqual(hello)
          socket.send(ack)
          socket.send(first, () => socket.terminate())
        } else {
          resume = data
          resumePeer = socket
          resumeAck = ack
          if (mode === 'valid' || mode === 'wrong-nonce') {
            socket.send(ack)
            socket.send(Buffer.from('def'))
          }
        }
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      await chmod(path, 0o600)
      const opened = await RexDataStream.open(path, ticket.toString('base64url'))
      stream = opened.stream
      expect(opened.tail.toString()).toBe('abc')
      // A paused consumer must not initiate resume or advance its byte offset.
      stream.pauseDelivery()
      const next = stream.next()
      const checked =
        mode === 'wrong-nonce'
          ? expect(next).rejects.toThrow('identity mismatch')
          : mode === 'close-during-resume'
            ? expect(next).rejects.toThrow('Rex data stream closed')
            : expect(next).resolves.toEqual(Buffer.from('def'))
      void checked.catch(() => undefined)
      await Promise.resolve()
      expect(connections).toBe(1)
      stream.resumeDelivery()
      if (mode === 'close-during-resume' || mode === 'concurrent-read') {
        await vi.waitFor(() => expect(resumePeer).toBeDefined())
        if (mode === 'close-during-resume') {
          stream.close()
          stream.close()
          await expect(stream.next()).rejects.toThrow(/closed|single reader/)
          await vi.waitFor(
            () => {
              expect(rexDataWireBudget.usage()).toEqual({ bytes: 0, objects: 0 })
              expect(rexDataReceiveBudget.usage()).toEqual({ bytes: 0, objects: 0 })
            },
            { timeout: 1000 }
          )
        } else {
          await expect(stream.next()).rejects.toThrow('single reader')
          resumePeer!.send(resumeAck!)
          resumePeer!.send(Buffer.from('def'))
        }
      }
      await checked
      expect(connections).toBe(2)
      const expected = Buffer.alloc(25)
      expected[0] = 2
      token.copy(expected, 1)
      expected.writeBigUInt64LE(BigInt(first.length), 17)
      expect(resume).toEqual(expected)
    } finally {
      stream?.close()
      for (const client of wss.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
