import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { sendEmulatorGestureSequence } from './emulator-gesture-sender'

describe('sendEmulatorGestureSequence', () => {
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
