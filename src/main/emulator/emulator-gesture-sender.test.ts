import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { sendEmulatorGestureSequence } from './emulator-gesture-sender'

describe('sendEmulatorGestureSequence', () => {
  it('rejects when the peer closes after the final point before sequence completion', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    wss.on('connection', (ws) => {
      ws.once('message', () => ws.close())
    })

    try {
      const address = wss.address()
      if (!address || typeof address === 'string') {
        throw new Error('Gesture test server did not bind')
      }
      await expect(
        sendEmulatorGestureSequence(`ws://127.0.0.1:${address.port}`, [
          { type: 'end', x: 0.5, y: 0.2 }
        ])
      ).rejects.toThrow('Emulator gesture stream closed before sequence completion')
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it('sends serve-sim touch JSON frames with move events', async () => {
    const messages: unknown[] = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const buffer = Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.isBuffer(raw)
            ? raw
            : Buffer.from(raw)
        expect(buffer[0]).toBe(0x03)
        messages.push(JSON.parse(buffer.subarray(1).toString('utf8')))
      })
    })

    try {
      const { port } = wss.address() as AddressInfo
      await sendEmulatorGestureSequence(`ws://127.0.0.1:${port}`, [
        { type: 'begin', x: 0.5, y: 0.8 },
        { type: 'move', x: 0.5, y: 0.5 },
        { type: 'end', x: 0.5, y: 0.2 }
      ])

      expect(messages).toEqual([
        { type: 'begin', x: 0.5, y: 0.8 },
        { type: 'move', x: 0.5, y: 0.5 },
        { type: 'end', x: 0.5, y: 0.2 }
      ])
    } finally {
      wss.close()
    }
  })
})
