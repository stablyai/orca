import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Debugger } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeBrowserScreencastFrame,
  type BrowserScreencastFormat
} from '../../shared/browser-screencast-protocol'
import { createBrowserScreencastMessageHandler } from './browser-screencast-cdp-events'
import { createBrowserScreencastFramePacer } from './browser-screencast-frame-pacer'
import type { BrowserScreencastOptions } from './browser-screencast-stream-types'
import { createMockScreencastWebContents } from './browser-screencast-web-contents-test-double'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function createLiveFrameRoute(
  format: BrowserScreencastFormat,
  onFrame: BrowserScreencastOptions['onFrame']
) {
  const acknowledgements: number[] = []
  const dbg: Debugger = Object.assign(createMockScreencastWebContents().debugger, {
    isAttached: () => false,
    attach: () => {},
    detach: () => {},
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.screencastFrameAck' && typeof params?.sessionId === 'number') {
        acknowledgements.push(params.sessionId)
      }
      return {}
    }
  })
  const options: BrowserScreencastOptions = {
    format,
    quality: 70,
    maxWidth: 1440,
    maxHeight: 1200,
    everyNthFrame: 2,
    minFrameIntervalMs: 0,
    onFrame
  }
  const isClosed = () => false
  const isStopping = () => false
  const pacer = createBrowserScreencastFramePacer({ dbg, options, isClosed, isStopping })
  const handler = createBrowserScreencastMessageHandler({
    dbg,
    options,
    isClosed,
    isStopping,
    queueFrame: pacer.queueFrame,
    ackScreencastFrame: pacer.ackFrame,
    scheduleNavigationFrameCapture: () => {},
    clearNavigationCaptureTimer: () => {},
    bumpSnapshotGeneration: () => {},
    setDialogOpen: () => {}
  })
  return {
    pacer,
    acknowledgements,
    emit: (data: string, sessionId: number) =>
      handler({}, 'Page.screencastFrame', { data, sessionId, metadata: { timestamp: 123.5 } })
  }
}

async function settleAcknowledgements(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
  }
}

describe('live screencast image allocation', () => {
  it('replays captured PNG and JPEG bytes without copying the decoded image again', async () => {
    const fixtures = [
      {
        format: 'png',
        path: 'docs/site/public/docs/remote-server-add-client.png',
        width: 832,
        height: 832
      },
      {
        format: 'jpeg',
        path: 'docs/site/public/docs/posters/file-drag.jpg',
        width: 1200,
        height: 682
      }
    ] as const
    const captures = fixtures.map((fixture) => {
      const bytes = readFileSync(resolve(fixture.path))
      return { ...fixture, bytes, data: bytes.toString('base64'), expectedDigest: digest(bytes) }
    })
    const nativeUint8Array = globalThis.Uint8Array
    let imageCopyBytes = 0
    globalThis.Uint8Array = new Proxy(nativeUint8Array, {
      construct(target, argumentsList, newTarget) {
        const source: unknown = argumentsList[0]
        const bytes: unknown = Reflect.construct(target, argumentsList, newTarget)
        if (!(bytes instanceof nativeUint8Array)) {
          throw new Error('Unexpected byte constructor result')
        }
        if (Buffer.isBuffer(source)) {
          imageCopyBytes += bytes.byteLength
        }
        return bytes
      }
    })
    try {
      for (const fixture of captures) {
        const seen: number[] = []
        const route = createLiveFrameRoute(fixture.format, (wire) => {
          const frame = decodeBrowserScreencastFrame(wire)
          if (!frame) {
            throw new Error('Captured frame was not encoded')
          }
          expect(frame.format).toBe(fixture.format)
          expect(frame.metadata.imageWidth).toBe(fixture.width)
          expect(frame.metadata.imageHeight).toBe(fixture.height)
          expect(frame.image.byteLength).toBe(fixture.bytes.byteLength)
          expect(digest(frame.image)).toBe(fixture.expectedDigest)
          seen.push(frame.seq)
          return true
        })
        for (let sessionId = 1; sessionId <= 12; sessionId++) {
          route.emit(fixture.data, sessionId)
        }
        await settleAcknowledgements()
        expect(seen).toEqual(Array.from({ length: 12 }, (_, index) => index))
        expect(route.acknowledgements).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
        route.pacer.clearPending(true)
      }
      expect(imageCopyBytes).toBe(0)
    } finally {
      globalThis.Uint8Array = nativeUint8Array
    }
  })

  it('owns pooled and offset images through refused sends and keeps encoded bytes independent', async () => {
    vi.useFakeTimers()
    const bytes = readFileSync(resolve('resources/tray/orca-menu-barTemplate.png'))
    const data = bytes.toString('base64')
    const expectedDigest = digest(bytes)
    const pooled = Buffer.from(data, 'base64')
    const parent = Buffer.alloc(bytes.byteLength + 4096, 0xa5)
    bytes.copy(parent, 127)
    const offset = parent.subarray(127, 127 + bytes.byteLength)
    try {
      expect(offset.byteOffset).toBe(127)
      for (const decoded of [pooled, offset]) {
        expect(decoded.buffer.byteLength).toBeGreaterThan(decoded.byteLength)
        let accepted = false
        const wires: Uint8Array[] = []
        const route = createLiveFrameRoute('png', (wire) => {
          wires.push(wire)
          return accepted
        })
        const from = vi.spyOn(Buffer, 'from').mockReturnValueOnce(decoded)
        try {
          route.emit(data, 42)
        } finally {
          from.mockRestore()
        }
        await settleAcknowledgements()
        expect(route.acknowledgements).toEqual([])
        decoded.fill(0)
        accepted = true
        await vi.advanceTimersByTimeAsync(50)
        expect(route.acknowledgements).toEqual([42])
        expect(wires).toHaveLength(2)
        for (const wire of wires) {
          const frame = decodeBrowserScreencastFrame(wire)
          if (!frame) {
            throw new Error('Pooled frame was not encoded')
          }
          expect(frame.metadata.imageWidth).toBe(22)
          expect(frame.metadata.imageHeight).toBe(14)
          expect(digest(frame.image)).toBe(expectedDigest)
          expect(wire.buffer).not.toBe(decoded.buffer)
        }
        expect(wires.map((wire) => decodeBrowserScreencastFrame(wire)?.seq)).toEqual([0, 1])
        route.pacer.clearPending(true)
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
