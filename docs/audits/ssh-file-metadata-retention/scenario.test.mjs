import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from '../../../src/main/ssh/ssh-channel-multiplexer'
import { readFileViaStream } from '../../../src/main/ssh/ssh-filesystem-stream-reader'
import {
  encodeJsonRpcFrame,
  MAX_CONCURRENT_STREAMS,
  STREAM_ACK_WINDOW_CHUNKS,
  STREAM_CHUNK_SIZE,
  RelayErrorCode
} from '../../../src/relay/protocol'
import {
  candidate,
  report,
  nextTurn,
  gates,
  heldFiles,
  connect,
  snapshot,
  collect,
  assertReleased,
  makePayload,
  successfulRead
} from './relay-fixture.mjs'
describe('actual SSH mux, relay dispatcher and file producer ownership', () => {
  it('retains shared foreign frames while four metadata request handlers are deliberately held', async () => {
    const paths = await heldFiles(4)
    const { mux, stats } = connect()
    const pending = paths.map((path) => readFileViaStream(mux, path))
    const payload = await makePayload(2 * 1024 * 1024)
    await collect()
    const startHeap = process.memoryUsage().heapUsed
    for (let i = 0; i < 16; i++) {
      await successfulRead(mux, payload)
    }
    await collect()
    const retained = snapshot(paths)
    expect(stats.chunks).toBe(128)
    expect(stats.ends).toBe(16)
    expect(stats.acks).toBe(128)
    expect(stats.peakStreams).toBe(1)
    expect(retained.entries).toEqual(Array(4).fill(candidate ? 0 : 144))
    expect(retained.uniqueParams).toBe(candidate ? 0 : 144)
    expect(retained.logicalBase64BytesByUniqueParams).toBe(
      candidate ? 0 : 128 * Math.ceil(STREAM_CHUNK_SIZE / 3) * 4
    )
    expect(retained.sharedAcrossReaders).toBe(!candidate)
    const heapDelta = process.memoryUsage().heapUsed - startHeap
    for (const path of paths) {
      gates.get(path).release()
    }
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({
        content: '',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }))
    )
    await assertReleased(paths)
    report.controls.push({
      name: 'held-metadata-foreign-history',
      ...retained,
      decodedTransferBytes: 16 * payload.size,
      peakRegisteredStreams: stats.peakStreams,
      maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      ackWindow: STREAM_ACK_WINDOW_CHUNKS,
      ackCount: stats.acks,
      observedHeapDelta: heapDelta,
      released: true
    })
  })
  it('finishes normally without a held metadata request and releases reader state', async () => {
    const { mux } = connect()
    const payload = await makePayload(STREAM_CHUNK_SIZE + 17)
    for (let i = 0; i < 3; i++) {
      await successfulRead(mux, payload)
    }
    await assertReleased([payload.path])
    report.controls.push({ name: 'ordinary-completion', passed: true })
  })
  it('cleans up all pending metadata listeners when transport is disposed', async () => {
    const paths = await heldFiles(2)
    const { mux } = connect()
    const pending = paths.map((path) =>
      readFileViaStream(mux, path).catch((error) => {
        void error.stack
        return error.code
      })
    )
    await successfulRead(mux, await makePayload(STREAM_CHUNK_SIZE + 1))
    expect(snapshot(paths).wrappers).toBe(candidate ? 0 : 6)
    mux.dispose('connection_lost')
    const results = await Promise.all(pending)
    expect(results).toEqual(['CONNECTION_LOST', 'CONNECTION_LOST'])
    await assertReleased(paths)
    report.controls.push({ name: 'transport-disposal', passed: true })
  })
  it('retains no reader history after the 30 second request deadline while relay work remains pending', async () => {
    const paths = await heldFiles(1)
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    const { mux, stats } = connect()
    const pending = readFileViaStream(mux, paths[0]).catch((error) => error)
    await successfulRead(mux, await makePayload(STREAM_CHUNK_SIZE))
    expect(snapshot(paths).wrappers).toBe(candidate ? 0 : 2)
    // Keep the actual mux/relay health timers active on the fake clock as well.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect((await pending).code).toBe('SSH_MUX_REQUEST_TIMEOUT')
    expect(stats.contexts[0].signal.aborted).toBe(true)
    vi.useRealTimers()
    await assertReleased(paths)
    report.controls.push({
      name: 'metadata-request-deadline',
      milliseconds: 30000,
      relayContextAborted: true,
      released: true
    })
  })
  it('supports a relay that ignores optional chunk pacing', async () => {
    const paths = await heldFiles(1)
    const { mux, stats } = connect({ pacing: false })
    const pending = readFileViaStream(mux, paths[0])
    await successfulRead(mux, await makePayload(2 * STREAM_CHUNK_SIZE + 7))
    expect(stats.chunks).toBe(3)
    expect(snapshot(paths).wrappers).toBe(candidate ? 0 : 4)
    gates.get(paths[0]).release()
    await pending
    await assertReleased(paths)
    report.controls.push({ name: 'unpaced-relay', passed: true })
  })
  it('actually stops the pump after four chunks until acknowledgements resume', async () => {
    const { mux, registry, stats } = connect({ passAcks: false })
    const payload = await makePayload(6 * STREAM_CHUNK_SIZE)
    const pending = successfulRead(mux, payload)
    for (let i = 0; i < 200 && stats.chunks < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(stats.chunks).toBe(4)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(stats.chunks).toBe(4)
    registry.recordAck(1, 3)
    await pending
    expect(stats.chunks).toBe(6)
    report.controls.push({ name: 'real-pump-credit-window', chunksBeforeAck: 4, totalChunks: 6 })
  })
  it('enforces the real 16 slot limit and admits another file after completion', async () => {
    const { mux, registry, stats } = connect({ passAcks: false })
    const payload = await makePayload(5 * STREAM_CHUNK_SIZE)
    const pending = Array.from({ length: 16 }, () => successfulRead(mux, payload))
    for (let i = 0; i < 500 && stats.chunks < 64; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(registry.size()).toBe(16)
    expect(stats.chunks).toBe(64)
    const error = await readFileViaStream(mux, payload.path).catch((error) => error)
    expect(error.code).toBe(RelayErrorCode.TooManyStreams)
    for (let id = 1; id <= 16; id++) {
      registry.recordAck(id, 3)
    }
    await Promise.all(pending)
    expect(registry.size()).toBe(0)
    const small = await makePayload(1)
    await successfulRead(mux, small)
    report.controls.push({
      name: 'actual-stream-capacity',
      slots: 16,
      rejectedSeventeenth: true,
      admittedAfterCompletion: true
    })
  })
  it('writes metadata before own chunks when the relay writer resumes from saturation', async () => {
    const fixture = connect({ blockFirstWrite: true })
    fixture.dispatcher.notifyClient(1, 'probe.prime')
    const payload = await makePayload(STREAM_CHUNK_SIZE + 1)
    const pending = successfulRead(fixture.mux, payload)
    for (let i = 0; i < 100 && fixture.stats.peakStreams < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await nextTurn()
    expect(fixture.stats.peakStreams).toBe(1)
    expect(fixture.stats.wireOrder).toEqual(['probe.prime'])
    fixture.drain()
    await pending
    expect(fixture.stats.wireOrder).toEqual([
      'probe.prime',
      'response',
      'fs.streamChunk',
      'fs.streamChunk',
      'fs.streamEnd'
    ])
    report.controls.push({
      name: 'saturated-writer-metadata-order',
      wireOrder: fixture.stats.wireOrder
    })
  })
  it('handles response and own chunk/end in one decoder dispatch turn', async () => {
    let receive
    let requestId
    const mux = new SshChannelMultiplexer({
      write(data) {
        if (data[0] === 1) {
          const message = JSON.parse(data.subarray(13).toString())
          if (message.method === 'fs.readFileStream') {
            requestId = message.id
          }
        }
      },
      onData(callback) {
        receive = callback
      },
      onClose() {}
    })
    const pending = readFileViaStream(mux, 'coalesced.png')
    const data = Buffer.from('adjacent\0frame')
    receive(
      Buffer.concat([
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            id: requestId,
            result: { streamId: 7, totalSize: data.length, isBinary: true }
          },
          1,
          0
        ),
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            method: 'fs.streamChunk',
            params: { streamId: 7, seq: 0, data: data.toString('base64') }
          },
          2,
          0
        ),
        encodeJsonRpcFrame(
          { jsonrpc: '2.0', method: 'fs.streamEnd', params: { streamId: 7 } },
          3,
          0
        )
      ])
    )
    expect(await pending).toEqual({ content: data.toString('base64'), isBinary: true })
    mux.dispose()
    await assertReleased(['coalesced.png'])
    report.controls.push({ name: 'same-turn-response-and-own-frames', passed: true })
  })
})

it('reconstructs both sources identically from synthetic CRLF checkout and patch reads', () => {
  const { loadSources } = createRequire(import.meta.url)('./sources.cjs')
  let reads = 0
  const observed = loadSources({
    read(filename) {
      reads += 1
      return readFileSync(filename, 'utf8').replace(/\r?\n/g, '\r\n')
    }
  })
  const ordinary = loadSources()
  expect(observed.hashes).toEqual(ordinary.hashes)
  expect([...observed.sources]).toEqual([...ordinary.sources])
  report.controls.push({ name: 'canonical-crlf-source-control', reads, passed: true })
})
