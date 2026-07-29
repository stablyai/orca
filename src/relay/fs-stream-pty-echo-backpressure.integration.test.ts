/**
 * Regression: SSH typing latency under bulk file-stream load.
 *
 * The relay and the client share ONE ordered SSH channel. If the relay
 * enqueues an entire file's fs.streamChunk frames into the outbound pipe
 * at once, an interactive pty.data echo emitted mid-stream queues behind
 * megabytes of bulk data and typing feels seconds-slow.
 *
 * These tests model the SSH channel as a congestible in-memory pipe and
 * assert deterministic byte bounds instead of wall-clock latency:
 *  - with a saturated sink, the relay stalls the pump on write backpressure
 *    so at most ~1 chunk frame sits ahead of a pty echo;
 *  - with a fast sink but an unresponsive client, the fs.streamAck credit
 *    window bounds the in-flight backlog;
 *  - legacy clients that never ack still receive the full stream.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'
import { readFileViaStream } from '../main/ssh/ssh-filesystem-stream-reader'

import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { FsHandler } from './fs-handler'
import { STREAM_CHUNK_SIZE } from './protocol'

// One framed fs.streamChunk: 256KB raw → base64 (4/3) + JSON envelope + header.
const FRAMED_CHUNK_BYTES = Math.ceil((STREAM_CHUNK_SIZE * 4) / 3) + 512
// Node pipe/socket sinks report saturation via write() === false past the HWM.
const SINK_HIGH_WATER_MARK = 64 * 1024

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out: ${what}`)
    }
    await new Promise((r) => setImmediate(r))
  }
}

/** Waits until `read()` stops changing for `stableTurns` macrotask turns. */
async function waitUntilSettled(read: () => number, stableTurns = 25): Promise<void> {
  let last = read()
  let stable = 0
  while (stable < stableTurns) {
    await new Promise((r) => setImmediate(r))
    const current = read()
    if (current === last) {
      stable += 1
    } else {
      stable = 0
      last = current
    }
  }
}

type Harness = {
  mux: SshChannelMultiplexer
  dispatcher: RelayDispatcher
  fsHandler: FsHandler
  queuedBytes: () => number
  /** Deliver every queued relay→client buffer to the client mux. */
  deliverAll: () => void
  /** Start delivering continuously on each macrotask turn. */
  startAutoDeliver: () => void
  dispose: () => void
}

function createHarness(opts: { congested: boolean }): Harness {
  let relayFeed: ((data: Buffer) => void) | null = null
  const clientDataCallbacks: ((data: Buffer) => void)[] = []

  const clientTransport: MultiplexerTransport = {
    write: (data: Buffer) => {
      // Client → relay: keystrokes and acks flow on the opposite direction of
      // the duplex channel; they are not blocked by relay→client congestion.
      setImmediate(() => relayFeed?.(data))
    },
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: () => {}
  }

  const outQueue: Buffer[] = []
  let queuedBytes = 0
  const drainWaiters = new Set<() => void>()
  const fireDrainIfIdle = (): void => {
    if (queuedBytes > 0) {
      return
    }
    for (const cb of Array.from(drainWaiters)) {
      drainWaiters.delete(cb)
      cb()
    }
  }

  const dispatcher = new RelayDispatcher(
    (data: Buffer) => {
      outQueue.push(data)
      queuedBytes += data.length
      if (!opts.congested) {
        return true
      }
      return queuedBytes < SINK_HIGH_WATER_MARK
    },
    {
      waitWriteDrain: (cb: () => void) => {
        drainWaiters.add(cb)
        fireDrainIfIdle()
      }
    }
  )
  relayFeed = (data: Buffer) => dispatcher.feed(data)

  const deliverAll = (): void => {
    while (outQueue.length > 0) {
      const buf = outQueue.shift()!
      queuedBytes -= buf.length
      for (const cb of clientDataCallbacks) {
        cb(buf)
      }
    }
    fireDrainIfIdle()
  }

  let autoDeliverTimer: ReturnType<typeof setInterval> | null = null
  const startAutoDeliver = (): void => {
    if (autoDeliverTimer) {
      return
    }
    autoDeliverTimer = setInterval(deliverAll, 1)
  }

  const context = new RelayContext()
  const fsHandler = new FsHandler(dispatcher, context)
  const mux = new SshChannelMultiplexer(clientTransport)

  return {
    mux,
    dispatcher,
    fsHandler,
    queuedBytes: () => queuedBytes,
    deliverAll,
    startAutoDeliver,
    dispose: () => {
      if (autoDeliverTimer) {
        clearInterval(autoDeliverTimer)
      }
      mux.dispose()
      dispatcher.dispose()
      fsHandler.dispose()
    }
  }
}

describe('fs.readFileStream vs pty.data echo head-of-line blocking', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-stream-hol-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('bounds bulk bytes queued ahead of a pty echo when the channel is congested', async () => {
    const harness = createHarness({ congested: true })
    try {
      const filePath = path.join(tmpDir, 'big.png')
      const original = randomBytes(3 * 1024 * 1024) // 12 chunks
      writeFileSync(filePath, original)

      // Relay-side fake PTY: echoes input back immediately, mirroring
      // PtyHandler's interactive fast path (dispatcher.notify on echo).
      let queuedBytesAheadOfEcho = -1
      harness.dispatcher.onNotification('pty.data', (params) => {
        queuedBytesAheadOfEcho = harness.queuedBytes()
        harness.dispatcher.notify('pty.data', { id: params.id, data: params.data })
      })

      const readPromise = readFileViaStream(harness.mux, filePath)
      // Deliver until the client has the stream metadata, then congest fully.
      await waitUntil(() => harness.queuedBytes() > 0, 'metadata response queued')
      harness.deliverAll()
      // Let the pump run to whatever bound it enforces (pre-fix: whole file).
      await waitUntil(() => harness.queuedBytes() > 0, 'first chunk queued')
      await waitUntilSettled(() => harness.queuedBytes())

      // Type one key while the stream is congested.
      harness.mux.notify('pty.data', { id: 'pty-1', data: 'x' })
      await waitUntil(() => queuedBytesAheadOfEcho >= 0, 'echo emitted by relay')

      // The echo must not sit behind an unbounded chunk backlog: at most one
      // in-flight bulk frame (the write that saturated the sink) plus slack.
      expect(queuedBytesAheadOfEcho).toBeLessThan(2 * FRAMED_CHUNK_BYTES)

      // Un-congest: the stream must still complete with intact content.
      harness.startAutoDeliver()
      const result = await readPromise
      expect(Buffer.from(result.content, 'base64').equals(original)).toBe(true)
    } finally {
      harness.dispose()
    }
  }, 30_000)

  it('caps in-flight chunks via the fs.streamAck credit window when the client stalls', async () => {
    const harness = createHarness({ congested: false })
    try {
      const filePath = path.join(tmpDir, 'big.png')
      writeFileSync(filePath, randomBytes(3 * 1024 * 1024)) // 12 chunks

      const receivedSeqs: number[] = []
      harness.mux.onNotificationByMethod('fs.streamChunk', (params) => {
        receivedSeqs.push(params.seq as number)
      })
      let streamEnded = false
      harness.mux.onNotificationByMethod('fs.streamEnd', () => {
        streamEnded = true
      })

      harness.startAutoDeliver()
      // Raw ack-capable request without sending any acks: models a client
      // whose main thread is too busy to process chunks.
      const metadata = (await harness.mux.request('fs.readFileStream', {
        filePath,
        flowControl: 'ack'
      })) as { streamId: number }

      await waitUntil(() => receivedSeqs.length > 0, 'first chunk received')
      await waitUntilSettled(() => receivedSeqs.length)

      // Without acks the relay must stop at the credit window, not flood
      // the remaining chunks.
      expect(receivedSeqs.length).toBeLessThanOrEqual(5)
      expect(streamEnded).toBe(false)

      // Acking releases the window and the stream completes.
      const totalChunks = 12
      for (let seq = 0; seq < totalChunks; seq += 1) {
        harness.mux.notify('fs.streamAck', { streamId: metadata.streamId, seq })
      }
      await waitUntil(() => streamEnded, 'stream completed after acks')
      expect(receivedSeqs).toEqual(Array.from({ length: totalChunks }, (_, i) => i))
    } finally {
      harness.dispose()
    }
  }, 30_000)

  it('still delivers the full stream to legacy clients that never ack', async () => {
    const harness = createHarness({ congested: false })
    try {
      const filePath = path.join(tmpDir, 'legacy.png')
      const original = randomBytes(1024 * 1024 + 12345)
      writeFileSync(filePath, original)

      const chunks = new Map<number, Buffer>()
      let streamEnded = false
      harness.mux.onNotificationByMethod('fs.streamChunk', (params) => {
        chunks.set(params.seq as number, Buffer.from(params.data as string, 'base64'))
      })
      harness.mux.onNotificationByMethod('fs.streamEnd', () => {
        streamEnded = true
      })

      harness.startAutoDeliver()
      // Legacy request shape: no flowControl param, and no acks ever sent.
      await harness.mux.request('fs.readFileStream', { filePath })
      await waitUntil(() => streamEnded, 'legacy stream completed')

      const reassembled = Buffer.concat(
        Array.from(chunks.entries())
          .sort(([a], [b]) => a - b)
          .map(([, buf]) => buf)
      )
      expect(reassembled.equals(original)).toBe(true)
    } finally {
      harness.dispose()
    }
  }, 30_000)
})
