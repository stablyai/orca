import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { RexWire } from './rex-wire'
import {
  rexDataReceiveBudget,
  rexControlReceiveBudget,
  rexDataWireBudget,
  rexControlWireBudget
} from './rex-memory-budget'

describe.skipIf(process.platform === 'win32')('aggregate Rex wire memory', () => {
  it('does not resume a rejected oversized WebSocket message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-wire-limit-'))
    const path = join(dir, 's')
    const server = createServer()
    const wss = new WebSocketServer({ server, perMessageDeflate: false })
    let wire: RexWire | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      wire = new RexWire(path, '/api/control', 'rex.control.v1')
      await wire.ready()
      const peer = [...wss.clients][0]
      const rejected = expect(wire.next()).rejects.toThrow('Max payload size exceeded')
      peer.send(Buffer.alloc(1024 * 1024 + 1))
      await rejected
      expect(wire.canResume).toBe(false)
    } finally {
      wire?.close()
      for (const peer of wss.clients) {
        peer.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
    await vi.waitFor(() => {
      expect(rexControlWireBudget.usage()).toEqual({ bytes: 0, objects: 0 })
      expect(rexControlReceiveBudget.usage()).toEqual({ bytes: 0, objects: 0 })
    })
  })

  it('bounds simultaneous stalled streams, protects control traffic and releases credits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-budget-'))
    const path = join(dir, 's')
    const server = createServer()
    const wss = new WebSocketServer({ server, perMessageDeflate: false })
    const peers: WebSocket[] = []
    const wires: RexWire[] = []
    wss.on('connection', (socket) => peers.push(socket))
    const frame = Buffer.alloc(8 * 1024 * 1024, 0x41)
    const charge = frame.length + 128
    async function open(route: string) {
      const wire = new RexWire(
        path,
        route,
        route === '/api/data' ? 'rex.data.terminal.v1' : 'rex.control.v1'
      )
      wires.push(wire)
      await wire.ready()
      return { wire, peer: peers.at(-1)! }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      for (let i = 0; i < 7; i++) {
        const { peer } = await open('/api/data')
        peer.send(frame)
        await vi.waitFor(() => expect(rexDataReceiveBudget.usage().bytes).toBe(charge * (i + 1)), {
          timeout: 5000
        })
      }
      // The frame held by a slow parser is still charged, not just the queue.
      expect((await wires[0].next()).length).toBe(frame.length)
      expect(rexDataReceiveBudget.usage().bytes).toBe(charge * 7)
      const overload = await open('/api/data')
      const rejected = expect(overload.wire.next()).rejects.toThrow(
        'aggregate receive budget exhausted'
      )
      overload.peer.send(frame)
      await rejected
      expect(rexDataReceiveBudget.usage().bytes).toBe(charge * 7)
      const control = await open('/api/control')
      control.peer.send('control stays available')
      expect((await control.wire.next()).toString()).toBe('control stays available')
      expect(rexControlReceiveBudget.usage().objects).toBe(1)
      wires[0].close()
      expect(rexDataReceiveBudget.usage().bytes).toBe(charge * 6)
      const replacement = await open('/api/data')
      replacement.peer.send(frame)
      expect((await replacement.wire.next()).length).toBe(frame.length)
      expect(rexDataReceiveBudget.usage().bytes).toBe(charge * 7)
    } finally {
      for (const wire of wires) {
        wire.close()
      }
      for (const peer of peers) {
        peer.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
    await vi.waitFor(() => {
      for (const budget of [
        rexDataReceiveBudget,
        rexControlReceiveBudget,
        rexDataWireBudget,
        rexControlWireBudget
      ]) {
        expect(budget.usage()).toEqual({ bytes: 0, objects: 0 })
      }
    })
  })
})
