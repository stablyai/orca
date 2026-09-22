import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeRpcEnvelopeSchema } from '../../../shared/runtime-rpc-envelope'
import { UnixSocketTransport } from './unix-socket-transport'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

type Runtime = { endpoint: string; dispatched: string[]; releaseAll: () => void }

async function startRuntime(maxConnections: number, holdMs: number | null): Promise<Runtime> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-conn-limit-'))
  const endpoint = join(dir, 'rt.sock')
  const transport = new UnixSocketTransport({ endpoint, kind: 'unix', maxConnections })
  const waiting: (() => void)[] = []
  const runtime: Runtime = {
    endpoint,
    dispatched: [],
    releaseAll: () => {
      for (const release of waiting.splice(0)) {
        release()
      }
    }
  }
  transport.onMessage((msg, reply) => {
    const id = readId(msg)
    runtime.dispatched.push(id)
    const respond = (): void =>
      reply(JSON.stringify({ id, ok: true, result: {}, _meta: { runtimeId: 'rt-1' } }))
    if (holdMs === null) {
      waiting.push(respond)
    } else {
      setTimeout(respond, holdMs)
    }
  })
  await transport.start()
  cleanups.push(async () => {
    runtime.releaseAll()
    await transport.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return runtime
}

function readId(raw: string): string {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
    throw new Error(`unexpected request: ${raw}`)
  }
  return String(parsed.id)
}

type RawResult = { data: string; closedAtMs: number }

/** Minimal client: writes one request line, collects every byte until the server closes. */
function rawRequest(endpoint: string, payload: string | null): Promise<RawResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const socket = createConnection(endpoint)
    let data = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      if (payload !== null) {
        socket.write(payload)
      }
    })
    socket.on('data', (chunk: string) => {
      data += chunk
      // Why: a real reply leaves the socket open for further requests; close once a frame lands.
      if (data.includes('\n')) {
        socket.end()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => resolve({ data, closedAtMs: Date.now() - startedAt }))
    cleanups.push(() => {
      socket.destroy()
    })
  })
}

function requestLine(id: string): string {
  return `${JSON.stringify({ id, authToken: 'token', method: 'terminal.send' })}\n`
}

async function saturate(runtime: Runtime, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    void rawRequest(runtime.endpoint, requestLine(`held-${i}`))
  }
  // Why: let the held connections be accepted before probing past the limit.
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const BUSY_FRAME_ERROR = {
  code: 'runtime_busy',
  message: 'Orca is busy (connection limit); retry shortly.',
  data: {
    retryable: true,
    reason: 'connection_limit',
    dispatched: false,
    nextSteps: ['Retry the command in a few seconds.']
  }
}

describe.skipIf(process.platform === 'win32')('UnixSocketTransport connection limit', () => {
  it('answers every request in a burst past the limit, and never dispatches the busy ones', async () => {
    const runtime = await startRuntime(32, 500)
    const ids = Array.from({ length: 35 }, (_, i) => `req-${i}`)

    const results = await Promise.all(
      ids.map((id) => rawRequest(runtime.endpoint, requestLine(id)))
    )

    const frames = results.map((result, i) => {
      // An empty result is the silent close the CLI used to report as a dead runtime.
      expect(result.data, `request ${ids[i]}`).not.toBe('')
      const frame: unknown = JSON.parse(result.data)
      expect(RuntimeRpcEnvelopeSchema.safeParse(frame).success).toBe(true)
      return frame
    })
    const ok = frames.filter(isOk)
    const busy = frames.filter((frame) => !isOk(frame))
    expect(ok).toHaveLength(32)
    expect(busy).toHaveLength(3)
    for (const frame of busy) {
      expect(frame).toMatchObject({ ok: false, error: BUSY_FRAME_ERROR })
    }
    const busyIds = busy.map((frame) => readId(JSON.stringify(frame)))
    expect(runtime.dispatched.filter((id) => busyIds.includes(id))).toEqual([])
    expect(runtime.dispatched).toHaveLength(32)
  })

  it('answers an over-limit socket with runtime_busy for its own id', async () => {
    const runtime = await startRuntime(2, null)
    await saturate(runtime, 2)

    const result = await rawRequest(runtime.endpoint, requestLine('req-over'))

    const frame: unknown = JSON.parse(result.data)
    expect(frame).toEqual({ id: 'req-over', ok: false, error: BUSY_FRAME_ERROR })
    // Why: every CLI, old or new, decodes through this schema; the frame must not read as invalid.
    expect(RuntimeRpcEnvelopeSchema.safeParse(frame).success).toBe(true)
    expect(runtime.dispatched).toEqual(['held-0', 'held-1'])
  })

  it('names an over-long request by its leading id without buffering the whole line', async () => {
    const runtime = await startRuntime(1, null)
    await saturate(runtime, 1)

    const result = await rawRequest(
      runtime.endpoint,
      `{"id":"req-big","method":"terminal.send","params":{"text":"${'x'.repeat(200_000)}"}}\n`
    )

    expect(JSON.parse(result.data)).toMatchObject({
      id: 'req-big',
      error: { code: 'runtime_busy' }
    })
    expect(runtime.dispatched).toEqual(['held-0'])
  })

  it('closes an over-limit socket that never names a request', async () => {
    const runtime = await startRuntime(1, null)
    await saturate(runtime, 1)

    const [garbage, silent] = await Promise.all([
      rawRequest(runtime.endpoint, 'not json\n'),
      rawRequest(runtime.endpoint, null)
    ])

    expect(garbage.data).toBe('')
    expect(silent.data).toBe('')
    // The silent socket is released by the read deadline, not held open.
    expect(silent.closedAtMs).toBeLessThan(3_000)
  })

  it('drops sockets unread past the busy-reply ceiling', async () => {
    const runtime = await startRuntime(2, null)
    await saturate(runtime, 2)
    // Two silent sockets fill the busy-reply band (ceiling = 2 × limit).
    const silent = [rawRequest(runtime.endpoint, null), rawRequest(runtime.endpoint, null)]
    await new Promise((resolve) => setTimeout(resolve, 100))

    const dropped = await rawRequest(runtime.endpoint, requestLine('req-dropped'))

    expect(dropped.data).toBe('')
    expect(dropped.closedAtMs).toBeLessThan(500)
    expect(runtime.dispatched).toEqual(['held-0', 'held-1'])
    await Promise.all(silent)
  })
})

function isOk(frame: unknown): boolean {
  return typeof frame === 'object' && frame !== null && 'ok' in frame && frame.ok === true
}
