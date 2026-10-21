import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  DaemonTransientAdmission,
  type AdmittedTransientRecord
} from './daemon-transient-admission'
import type { TerminalTransientObservation } from '../../shared/terminal-transient-observation'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createBinaryStreamFrameReader } from './daemon-stream-binary-framing'
import { extractOrderedRendererQueryData } from '../../shared/terminal-reply-query-extraction'

const current: TerminalTransientObservation = {
  kind: 'install',
  revision: 0,
  rawEndSeq: 0,
  current: { command: 'unseen', commandRevision: 0, mode2031: 'unknown', modeRevision: 0 }
}

describe('negotiated transient retention', () => {
  it.each(['ndjson', 'binary-v1'] as const)(
    'retains partial writes across %s stream replacement and keeps query salvage ordered',
    (streamFraming) => {
      vi.useFakeTimers()
      const oldSocket = new Socket()
      const replacement = new Socket()
      let socket = oldSocket
      const callbacks = new Map<Socket, (() => void)[]>()
      const events: unknown[] = []
      const reader = createBinaryStreamFrameReader(
        (event) => events.push(event),
        (error) => {
          throw error
        }
      )
      for (const target of [oldSocket, replacement]) {
        const pending: (() => void)[] = []
        callbacks.set(target, pending)
        vi.spyOn(target, 'write').mockImplementation((...args: unknown[]) => {
          const line = args[0]
          if (streamFraming === 'binary-v1' && Buffer.isBuffer(line)) {
            reader.feed(line)
          } else {
            events.push(JSON.parse(String(line)))
          }
          const callback = args.find((arg) => typeof arg === 'function')
          if (typeof callback === 'function') {
            pending.push(() => callback())
          }
          return true
        })
      }
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket, streamFraming }), {
        isSessionDroppable: () => true,
        salvageDroppedData: extractOrderedRendererQueryData
      })
      try {
        const sink = batcher.bindTransients('client', 'session', 'subscription', 'stream')!
        sink.install(current, 'incarnation', () => current)
        batcher.enqueue('client', 'session', `\x1b[6n\x1b[5n${'x'.repeat(1100 * 1024)}`)
        sink.stage({
          kind: 'observation',
          revision: 1,
          rawEndSeq: 1100 * 1024 + 8,
          fact: { kind: 'bell' }
        })
        sink.commit()
        batcher.flush('client')
        expect(batcher.queuedCharsForClient('client')).toBeGreaterThan(0)
        socket = replacement
        batcher.replaceStream('client')
        batcher.flush('client')
        oldSocket.emit('close')
        // Each iteration settles the actual next socket writes, allowing its retained FIFO to refill.
        for (let pass = 0; pass < 100 && batcher.queuedCharsForClient('client') > 0; pass++) {
          for (const callback of callbacks.get(replacement)!.splice(0)) {
            callback()
          }
          vi.runOnlyPendingTimers()
        }
        expect(batcher.queuedCharsForClient('client')).toBe(0)
        const data: string[] = []
        for (const event of events) {
          if (
            typeof event === 'object' &&
            event !== null &&
            'event' in event &&
            event.event === 'data' &&
            'payload' in event &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'data' in event.payload &&
            typeof event.payload.data === 'string'
          ) {
            data.push(event.payload.data)
          }
        }
        expect(data.join('')).toBe(`\x1b[6n\x1b[5n${'x'.repeat(512 * 1024)}`)
        replacement.emit('close')
        for (const pending of callbacks.values()) {
          for (const callback of pending) {
            callback()
            callback()
          }
        }
      } finally {
        batcher.clear()
        oldSocket.destroy()
        replacement.destroy()
        vi.useRealTimers()
      }
    }
  )

  it('keeps queued and written controls bounded until real batcher write callbacks settle', () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const replacement = new Socket()
    let currentSocket = socket
    const callbacks: (() => void)[] = []
    const writes = vi.fn((...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === 'function')
      if (typeof callback === 'function') {
        callbacks.push(() => callback())
      }
      return true
    })
    vi.spyOn(socket, 'write').mockImplementation(writes)
    vi.spyOn(replacement, 'write').mockImplementation(writes)
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: currentSocket }))
    try {
      for (let n = 0; n < 1600; n++) {
        if (n === 800) {
          currentSocket = replacement
          batcher.replaceStream('client')
        }
        const sink = batcher.bindTransients('client', 'session', 'subscription', 'stream')!
        sink.install(current, 'incarnation', () => current)
        batcher.flush('client')
        sink.dispose?.()
      }
      expect(writes.mock.calls.length).toBeGreaterThan(0)
      expect(writes.mock.calls.length).toBeLessThan(3200)
      for (const callback of callbacks.splice(0)) {
        callback()
      }
      const before = writes.mock.calls.length
      const sink = batcher.bindTransients('client', 'session', 'replacement', 'stream')!
      sink.install(current, 'incarnation', () => current)
      sink.stage({ kind: 'observation', revision: 1, rawEndSeq: 5, fact: { kind: 'bell' } })
      batcher.enqueue('client', 'session', 'paint', { flushImmediately: true })
      sink.commit()
      batcher.flush('client')
      expect(
        writes.mock.calls.slice(before).map(([line]) => {
          const event = JSON.parse(String(line))
          return event.event === 'data' ? event.payload.data : event.payload.kind
        })
      ).toEqual(['install', '', 'paint', 'observation'])
      socket.emit('close')
      replacement.emit('close')
      for (const callback of callbacks) {
        callback()
        callback()
      }
    } finally {
      batcher.clear()
      socket.destroy()
      replacement.destroy()
      vi.useRealTimers()
    }
  })

  it('bounds repeated reattach while writes stall and releases once on close or callback', () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const written: AdmittedTransientRecord[] = []
    const admission = new DaemonTransientAdmission(
      socket,
      'ndjson',
      (_id, record) => {
        // This is the batcher's actual ownership transfer: no completion until the socket settles.
        written.push(record.startWrite(socket))
      },
      () => {}
    )
    try {
      for (let n = 0; n < 1600; n++) {
        const sink = admission.bind(
          'session',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002'
        )!
        sink.install(current, '00000000-0000-0000-0000-000000000003', () => current)
        sink.dispose?.()
      }
      expect(admission.retained().bytes).toBe(
        4096 + written.reduce((sum, record) => sum + record.bytes, 0)
      )
      expect(admission.retained().bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
      written[0].release()
      const afterCallback = admission.retained()
      written[0].release()
      expect(admission.retained()).toEqual(afterCallback)
      socket.emit('close')
      expect(admission.retained()).toEqual({ bytes: 4096, records: 0 })
    } finally {
      admission.dispose()
      socket.destroy()
      vi.useRealTimers()
    }
  })
})
