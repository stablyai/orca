// Live-socket rig for the daemon stream backpressure queue: a real DaemonServer
// on a real unix socket with a client whose stream reader stalls, so Node's
// write(false)/drain signals come from actual kernel socket buffers instead of
// fake sockets. Complements the unit contracts in daemon-stream-data-batcher.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { DaemonServer } from './daemon-server'
import { encodeNdjson, createNdjsonParser } from './ndjson'
import { PROTOCOL_VERSION } from './types'
import type { SubprocessHandle } from './session'
import { getDaemonSocketPath } from './daemon-spawner'

const MAX_BACKPRESSURED_BYTES = 8 * 1024 * 1024

type ScriptedSubprocess = SubprocessHandle & {
  _emitData: (data: string) => void
  _emitExit: (code: number) => void
}

function createScriptedSubprocess(onWrite?: (data: string) => void): ScriptedSubprocess {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 44444,
    getForegroundProcess: () => null,
    write(data: string) {
      onWrite?.(data)
    },
    resize() {},
    kill() {
      setTimeout(() => onExitCb?.(0), 5)
    },
    forceKill() {},
    signal() {},
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose() {},
    _emitData(data: string) {
      onDataCb?.(data)
    },
    _emitExit(code: number) {
      onExitCb?.(code)
    }
  }
}

type QueuedLine = { sessionId: string; line: string; priority?: boolean }
type BackpressureEntry = { socket: Socket; lines: QueuedLine[]; queuedBytes: number }
type DaemonInternals = {
  clients: Map<string, { clientId: string; streamSocket: Socket | null }>
  streamDataBatcher: {
    pendingByClient: Map<string, unknown>
    backpressureQueue: { byClient: Map<string, BackpressureEntry> }
  }
}

type StreamFrame = {
  type: string
  event?: string
  sessionId?: string
  payload?: { data?: string; code?: number }
}

type RigStream = {
  socket: Socket
  frames: StreamFrame[]
  parseErrors: number
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

describe('DaemonServer live-socket backpressure', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null = null
  let openSockets: Socket[] = []
  const subprocesses = new Map<string, ScriptedSubprocess>()
  const echoOnWrite = new Map<string, (data: string) => void>()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-live-rig-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'rig.token')
    subprocesses.clear()
    echoOnWrite.clear()
  })

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.destroy()
    }
    openSockets = []
    await server?.shutdown()
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(): Promise<DaemonInternals> {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: (opts) => {
        const subprocess = createScriptedSubprocess((data) =>
          echoOnWrite.get(opts.sessionId)?.(data)
        )
        subprocesses.set(opts.sessionId, subprocess)
        return subprocess
      }
    })
    await server.start()
    return server as unknown as DaemonInternals
  }

  async function connectRawHello(role: 'control' | 'stream', clientId: string): Promise<Socket> {
    const socket = connect(socketPath)
    openSockets.push(socket)
    socket.on('error', () => {})
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      encodeNdjson({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf-8').trim(),
        clientId,
        role
      })
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('data', (data: Buffer) => {
        const parsed = JSON.parse(data.toString().trim()) as { ok?: boolean; error?: string }
        if (parsed.ok) {
          resolve()
        } else {
          reject(new Error(parsed.error ?? 'hello rejected'))
        }
      })
    })
    return socket
  }

  function attachStreamParser(socket: Socket): RigStream {
    const stream: RigStream = { socket, frames: [], parseErrors: 0 }
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => stream.frames.push(msg as StreamFrame),
      () => {
        stream.parseErrors += 1
      }
    )
    socket.on('data', (chunk: Buffer) => parser.feed(decoder.write(chunk)))
    return stream
  }

  type RigControl = {
    request: (type: string, payload: Record<string, unknown>) => Promise<unknown>
  }

  function attachControl(socket: Socket): RigControl {
    const pending = new Map<string, (response: { ok: boolean; error?: string }) => void>()
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => {
        const response = msg as { id?: string; ok: boolean; error?: string }
        if (response.id && pending.has(response.id)) {
          const resolve = pending.get(response.id)!
          pending.delete(response.id)
          resolve(response)
        }
      },
      () => {}
    )
    socket.on('data', (chunk: Buffer) => parser.feed(decoder.write(chunk)))
    let nextId = 0
    return {
      request: (type, payload) => {
        const id = `rig-${nextId++}`
        return new Promise((resolve, reject) => {
          pending.set(id, (response) => {
            if (response.ok) {
              resolve(response)
            } else {
              reject(new Error(response.error ?? `request ${type} failed`))
            }
          })
          socket.write(encodeNdjson({ id, type, payload }))
        })
      }
    }
  }

  function dataText(stream: RigStream, sessionId: string): string {
    return stream.frames
      .filter((frame) => frame.event === 'data' && frame.sessionId === sessionId)
      .map((frame) => frame.payload?.data ?? '')
      .join('')
  }

  function receivedCounters(stream: RigStream, sessionId: string): number[] {
    const counters: number[] = []
    for (const match of dataText(stream, sessionId).matchAll(/C(\d{8})\n/g)) {
      counters.push(Number(match[1]))
    }
    return counters
  }

  // Counter-tagged flood lines: ~64 bytes each so a 4096-line chunk is ~256KB.
  function floodChunk(firstCounter: number, lines: number): { data: string; next: number } {
    let data = ''
    for (let index = 0; index < lines; index += 1) {
      data += `${'x'.repeat(54)}C${String(firstCounter + index).padStart(8, '0')}\n`
    }
    return { data, next: firstCounter + lines }
  }

  function queueEntry(daemon: DaemonInternals, clientId: string): BackpressureEntry | undefined {
    return daemon.streamDataBatcher.backpressureQueue.byClient.get(clientId)
  }

  async function waitForFlush(daemon: DaemonInternals, clientId: string): Promise<void> {
    await waitFor(() => !daemon.streamDataBatcher.pendingByClient.has(clientId))
  }

  // Pumps counter-tagged chunks through the real batcher (8ms timer flushes)
  // until the server's stream write has genuinely deferred on write(false).
  async function floodUntilBackpressured(
    daemon: DaemonInternals,
    clientId: string,
    sessionId: string,
    firstCounter: number
  ): Promise<number> {
    let counter = firstCounter
    await waitFor(() => subprocesses.has(sessionId))
    const subprocess = subprocesses.get(sessionId)!
    for (let round = 0; round < 64 && !queueEntry(daemon, clientId); round += 1) {
      const chunk = floodChunk(counter, 4096)
      counter = chunk.next
      subprocess._emitData(chunk.data)
      await waitForFlush(daemon, clientId)
    }
    expect(queueEntry(daemon, clientId)).toBeDefined()
    return counter
  }

  async function pumpChunks(
    daemon: DaemonInternals,
    clientId: string,
    sessionId: string,
    firstCounter: number,
    rounds: number
  ): Promise<number> {
    let counter = firstCounter
    const subprocess = subprocesses.get(sessionId)!
    for (let round = 0; round < rounds; round += 1) {
      const chunk = floodChunk(counter, 4096)
      counter = chunk.next
      subprocess._emitData(chunk.data)
      await waitForFlush(daemon, clientId)
    }
    return counter
  }

  async function setupClient(
    clientId: string
  ): Promise<{ control: RigControl; stream: RigStream }> {
    const controlSocket = await connectRawHello('control', clientId)
    const control = attachControl(controlSocket)
    const streamSocket = await connectRawHello('stream', clientId)
    const stream = attachStreamParser(streamSocket)
    return { control, stream }
  }

  it(
    'keeps queued stream bytes bounded against a stalled real socket',
    { timeout: 90_000 },
    async () => {
      const daemon = await startServer()
      const clientId = 'client-live-bounded'
      const { control, stream } = await setupClient(clientId)
      await control.request('createOrAttach', { sessionId: 'sess-flood', cols: 80, rows: 24 })

      stream.socket.pause()
      let counter = await floodUntilBackpressured(daemon, clientId, 'sess-flood', 0)
      // Push far past the 8MB bound (~20MB more) in paced ~256KB flushes.
      counter = await pumpChunks(daemon, clientId, 'sess-flood', counter, 80)

      const entry = queueEntry(daemon, clientId)
      expect(entry).toBeDefined()
      // Soft bound: maxQueuedBytes plus at most one frame; paced flushes keep frames ~256KB.
      expect(entry!.queuedBytes).toBeLessThanOrEqual(MAX_BACKPRESSURED_BYTES + 1024 * 1024)
      // The deferred writer must not keep stuffing Node's userspace socket buffer.
      const serverSocket = daemon.clients.get(clientId)!.streamSocket!
      expect(serverSocket.writableLength).toBeLessThanOrEqual(2 * 1024 * 1024)
    }
  )

  it(
    'delivers a lossless ordered stream after drain when the backlog stays under the bound',
    { timeout: 90_000 },
    async () => {
      const daemon = await startServer()
      const clientId = 'client-live-lossless'
      const { control, stream } = await setupClient(clientId)
      await control.request('createOrAttach', { sessionId: 'sess-lossless', cols: 80, rows: 24 })

      stream.socket.pause()
      let counter = await floodUntilBackpressured(daemon, clientId, 'sess-lossless', 0)
      // Stay well under the 8MB queue bound so nothing may legally be trimmed.
      counter = await pumpChunks(daemon, clientId, 'sess-lossless', counter, 12)

      stream.socket.resume()
      await waitFor(() => receivedCounters(stream, 'sess-lossless').at(-1) === counter - 1)

      const counters = receivedCounters(stream, 'sess-lossless')
      expect(stream.parseErrors).toBe(0)
      expect(counters.length).toBe(counter)
      expect(counters).toEqual(Array.from({ length: counter }, (_, index) => index))
    }
  )

  it(
    'preserves the newest contiguous tail when the backlog exceeds the bound',
    { timeout: 90_000 },
    async () => {
      const daemon = await startServer()
      const clientId = 'client-live-tail'
      const { control, stream } = await setupClient(clientId)
      await control.request('createOrAttach', { sessionId: 'sess-tail', cols: 80, rows: 24 })

      stream.socket.pause()
      let counter = await floodUntilBackpressured(daemon, clientId, 'sess-tail', 0)
      // ~20MB past the bound forces bounded-queue trimming of the oldest backlog.
      counter = await pumpChunks(daemon, clientId, 'sess-tail', counter, 80)

      stream.socket.resume()
      await waitFor(() => receivedCounters(stream, 'sess-tail').at(-1) === counter - 1)

      const counters = receivedCounters(stream, 'sess-tail')
      expect(stream.parseErrors).toBe(0)
      let monotonic = true
      let gapCount = 0
      for (let index = 1; index < counters.length; index += 1) {
        if (counters[index] <= counters[index - 1]) {
          monotonic = false
        }
        if (counters[index] > counters[index - 1] + 1) {
          gapCount += 1
        }
      }
      expect(monotonic).toBe(true)
      // Trims only ever drop the oldest queued lines, so the delivered stream is
      // an intact prefix plus an intact newest tail: exactly one gap.
      expect(gapCount).toBe(1)
      expect(counters.length).toBeLessThan(counter)
      expect(counters.at(-1)).toBe(counter - 1)
    }
  )

  it(
    'keeps a session exit frame behind its drained output tail on a real socket',
    { timeout: 90_000 },
    async () => {
      const daemon = await startServer()
      const clientId = 'client-live-exit'
      const { control, stream } = await setupClient(clientId)
      await control.request('createOrAttach', { sessionId: 'sess-exit', cols: 80, rows: 24 })

      stream.socket.pause()
      let counter = await floodUntilBackpressured(daemon, clientId, 'sess-exit', 0)
      counter = await pumpChunks(daemon, clientId, 'sess-exit', counter, 8)

      subprocesses.get('sess-exit')!._emitExit(0)
      stream.socket.resume()
      await waitFor(() =>
        stream.frames.some((frame) => frame.event === 'exit' && frame.sessionId === 'sess-exit')
      )

      const exitIndex = stream.frames.findIndex(
        (frame) => frame.event === 'exit' && frame.sessionId === 'sess-exit'
      )
      let lastDataIndex = -1
      for (let index = 0; index < stream.frames.length; index += 1) {
        const frame = stream.frames[index]
        if (frame.event === 'data' && frame.sessionId === 'sess-exit') {
          lastDataIndex = index
        }
      }
      expect(lastDataIndex).toBeGreaterThan(-1)
      expect(exitIndex).toBeGreaterThan(lastDataIndex)
      expect(stream.frames[exitIndex].payload?.code).toBe(0)
      // Under-bound backlog: the full tail must precede the exit frame.
      expect(receivedCounters(stream, 'sess-exit').at(-1)).toBe(counter - 1)
      expect(stream.parseErrors).toBe(0)
    }
  )

  it(
    'delivers interactive echo ahead of unrelated queued backlog on drain',
    { timeout: 90_000 },
    async () => {
      const daemon = await startServer()
      const clientId = 'client-live-priority'
      const { control, stream } = await setupClient(clientId)
      await control.request('createOrAttach', { sessionId: 'sess-bg', cols: 80, rows: 24 })
      await control.request('createOrAttach', { sessionId: 'sess-fg', cols: 80, rows: 24 })
      echoOnWrite.set('sess-fg', (data) => subprocesses.get('sess-fg')!._emitData(`echo:${data}`))

      stream.socket.pause()
      let counter = await floodUntilBackpressured(daemon, clientId, 'sess-bg', 0)
      counter = await pumpChunks(daemon, clientId, 'sess-bg', counter, 8)

      const entry = queueEntry(daemon, clientId)!
      const firstQueuedLine = entry.lines.find((line) => line.sessionId === 'sess-bg')
      const firstQueuedCounter = Number(firstQueuedLine!.line.match(/C(\d{8})/)![1])

      await control.request('write', { sessionId: 'sess-fg', data: 'k' })
      await waitFor(() => entry.lines.some((line) => line.sessionId === 'sess-fg'))

      stream.socket.resume()
      await waitFor(() => receivedCounters(stream, 'sess-bg').at(-1) === counter - 1)
      await waitFor(() => dataText(stream, 'sess-fg').includes('echo:k'))

      const fgIndex = stream.frames.findIndex(
        (frame) => frame.event === 'data' && frame.sessionId === 'sess-fg'
      )
      const firstQueuedTag = `C${String(firstQueuedCounter).padStart(8, '0')}`
      const bgQueuedIndex = stream.frames.findIndex(
        (frame) =>
          frame.event === 'data' &&
          frame.sessionId === 'sess-bg' &&
          (frame.payload?.data ?? '').includes(firstQueuedTag)
      )
      expect(fgIndex).toBeGreaterThan(-1)
      expect(bgQueuedIndex).toBeGreaterThan(-1)
      // The interactive echo must jump the queued (not yet written) backlog.
      expect(fgIndex).toBeLessThan(bgQueuedIndex)
      expect(stream.parseErrors).toBe(0)
    }
  )

  it(
    'routes exit through the current stream socket after a same-clientId reconnect, behind its queued tail',
    { timeout: 90_000 },
    async () => {
      const daemon = await startServer()
      const clientId = 'client-live-reconnect'
      const { control, stream } = await setupClient(clientId)
      await control.request('createOrAttach', { sessionId: 'sess-reconnect', cols: 80, rows: 24 })

      stream.socket.pause()
      await floodUntilBackpressured(daemon, clientId, 'sess-reconnect', 0)
      const oldStream = stream
      const oldServerStreamSocket = daemon.clients.get(clientId)!.streamSocket!

      // Same-clientId reconnect: the server installs a new client pair and
      // destroys the old sockets; the old backpressured queue is dropped.
      // (The old client-side socket stays paused, so it never reads the FIN —
      // observe the replacement on the server side instead.)
      const newControlSocket = await connectRawHello('control', clientId)
      const newControl = attachControl(newControlSocket)
      const newStreamSocket = await connectRawHello('stream', clientId)
      const newStream = attachStreamParser(newStreamSocket)
      await waitFor(() => {
        const current = daemon.clients.get(clientId)?.streamSocket
        return current != null && current !== oldServerStreamSocket
      })
      await waitFor(() => oldServerStreamSocket.destroyed)
      await waitFor(() => queueEntry(daemon, clientId) === undefined)

      // Backpressure the NEW stream socket with fresh output, then exit the
      // session that was attached before the reconnect (the stale-closure case).
      newStream.socket.pause()
      const tailStart = 10_000_000
      let counter = await floodUntilBackpressured(daemon, clientId, 'sess-reconnect', tailStart)
      counter = await pumpChunks(daemon, clientId, 'sess-reconnect', counter, 4)

      subprocesses.get('sess-reconnect')!._emitExit(5)
      newStream.socket.resume()
      await waitFor(() =>
        newStream.frames.some(
          (frame) => frame.event === 'exit' && frame.sessionId === 'sess-reconnect'
        )
      )

      const exitIndex = newStream.frames.findIndex(
        (frame) => frame.event === 'exit' && frame.sessionId === 'sess-reconnect'
      )
      expect(newStream.frames[exitIndex].payload?.code).toBe(5)
      let lastDataIndex = -1
      for (let index = 0; index < newStream.frames.length; index += 1) {
        const frame = newStream.frames[index]
        if (frame.event === 'data' && frame.sessionId === 'sess-reconnect') {
          lastDataIndex = index
        }
      }
      expect(lastDataIndex).toBeGreaterThan(-1)
      expect(exitIndex).toBeGreaterThan(lastDataIndex)
      // The new socket's own queued tail drained intact ahead of the exit.
      expect(receivedCounters(newStream, 'sess-reconnect').at(-1)).toBe(counter - 1)
      // The pre-reconnect socket never saw the exit.
      expect(oldStream.frames.some((frame) => frame.event === 'exit')).toBe(false)
      // The daemon stayed healthy across the reconnect + exit.
      await newControl.request('ping', {})
      expect(newStream.parseErrors).toBe(0)
    }
  )
})
