import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { EmulatorError } from './emulator-errors'
import {
  insertServeSimPasteboardText,
  sendServeSimKeyboardFrameSequence
} from './serve-sim-text-insertion'

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'

type DecodedFrame = { type: string; usage: number }

function decodeFrame(raw: unknown): DecodedFrame {
  const buffer = Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw as ArrayBuffer)
  expect(buffer[0]).toBe(0x06)
  return JSON.parse(buffer.subarray(1).toString('utf8')) as DecodedFrame
}

describe('insertServeSimPasteboardText', () => {
  it('sets the pasteboard, then sends the Cmd+V chord over the ws', async () => {
    const events: string[] = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = decodeFrame(raw)
        events.push(`frame:${frame.type}:${frame.usage}`)
      })
    })

    try {
      const { port } = wss.address() as AddressInfo
      const setPasteboardText = vi.fn(async (udid: string) => {
        expect(udid).toBe(UDID)
        events.push('pasteboard')
      })

      await insertServeSimPasteboardText(
        { udid: UDID, text: '안녕하세요 🙂', wsUrl: `ws://127.0.0.1:${port}` },
        { setPasteboardText, settleDelayMs: 0, frameDelayMs: 0 }
      )
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(events).toEqual([
        'pasteboard',
        'frame:down:227',
        'frame:down:25',
        'frame:up:25',
        'frame:up:227'
      ])
    } finally {
      wss.close()
    }
  })

  it('serializes concurrent insertions for the same device', async () => {
    const events: string[] = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = decodeFrame(raw)
        if (frame.usage === 25 && frame.type === 'down') {
          events.push('chord')
        }
      })
    })

    try {
      const { port } = wss.address() as AddressInfo
      const wsUrl = `ws://127.0.0.1:${port}`
      // Make the first pasteboard write slow so the second call would overtake
      // it without a per-device queue.
      let call = 0
      const setPasteboardText = vi.fn(async () => {
        const index = ++call
        events.push(`pbcopy${index}`)
        if (index === 1) {
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
      })

      await Promise.all([
        insertServeSimPasteboardText(
          { udid: UDID, text: '첫번째', wsUrl },
          { setPasteboardText, settleDelayMs: 0, frameDelayMs: 0 }
        ),
        insertServeSimPasteboardText(
          { udid: UDID, text: '두번째', wsUrl },
          { setPasteboardText, settleDelayMs: 0, frameDelayMs: 0 }
        )
      ])
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Each insertion completes its pbcopy → chord pair before the next starts.
      expect(events).toEqual(['pbcopy1', 'chord', 'pbcopy2', 'chord'])
    } finally {
      wss.close()
    }
  })

  it('keeps the device queue usable after a failed insertion', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')

    try {
      const { port } = wss.address() as AddressInfo
      const wsUrl = `ws://127.0.0.1:${port}`
      const setPasteboardText = vi
        .fn()
        .mockRejectedValueOnce(new Error('pbcopy failed'))
        .mockResolvedValueOnce(undefined)

      await expect(
        insertServeSimPasteboardText(
          { udid: UDID, text: '실패', wsUrl },
          { setPasteboardText, settleDelayMs: 0, frameDelayMs: 0 }
        )
      ).rejects.toThrow('pbcopy failed')

      await expect(
        insertServeSimPasteboardText(
          { udid: UDID, text: '성공', wsUrl },
          { setPasteboardText, settleDelayMs: 0, frameDelayMs: 0 }
        )
      ).resolves.toBeUndefined()
      expect(setPasteboardText).toHaveBeenCalledTimes(2)
    } finally {
      wss.close()
    }
  })

  it('requires an active stream before touching the pasteboard', async () => {
    const setPasteboardText = vi.fn()

    const failure = await insertServeSimPasteboardText(
      { udid: UDID, text: '안녕', wsUrl: null },
      { setPasteboardText }
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(EmulatorError)
    expect((failure as EmulatorError).code).toBe('emulator_no_active')
    expect(setPasteboardText).not.toHaveBeenCalled()
  })

  it('rejects oversized text before touching the pasteboard, without echoing it', async () => {
    const setPasteboardText = vi.fn()
    const oversized = '가'.repeat(64 * 1024)

    const failure = await insertServeSimPasteboardText(
      { udid: UDID, text: oversized, wsUrl: 'ws://127.0.0.1:9' },
      { setPasteboardText }
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(EmulatorError)
    expect((failure as EmulatorError).code).toBe('emulator_error')
    expect((failure as EmulatorError).message).not.toContain('가')
    expect(setPasteboardText).not.toHaveBeenCalled()
  })
})

describe('sendServeSimKeyboardFrameSequence', () => {
  it('releases held usages over a fresh connection when the stream dies mid-chord', async () => {
    const firstConnectionFrames: DecodedFrame[] = []
    const releaseFrames: DecodedFrame[] = []
    let connections = 0
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    wss.on('connection', (ws) => {
      connections += 1
      const isFirst = connections === 1
      ws.on('message', (raw) => {
        const frame = decodeFrame(raw)
        if (isFirst) {
          firstConnectionFrames.push(frame)
          // Kill the stream once Cmd and V are both held down.
          if (firstConnectionFrames.length === 2) {
            ws.terminate()
          }
          return
        }
        releaseFrames.push(frame)
      })
    })

    try {
      const { port } = wss.address() as AddressInfo
      const failure = await sendServeSimKeyboardFrameSequence(
        `ws://127.0.0.1:${port}`,
        [
          { type: 'down', usage: 227 },
          { type: 'down', usage: 25 },
          { type: 'up', usage: 25 },
          { type: 'up', usage: 227 }
        ],
        { frameDelayMs: 40 }
      ).catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(failure).toBeInstanceOf(Error)
      expect(firstConnectionFrames).toEqual([
        { type: 'down', usage: 227 },
        { type: 'down', usage: 25 }
      ])
      expect(connections).toBe(2)
      expect(releaseFrames).toEqual([
        { type: 'up', usage: 25 },
        { type: 'up', usage: 227 }
      ])
    } finally {
      wss.close()
    }
  })
})
