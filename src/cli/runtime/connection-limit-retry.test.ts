import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { buildRuntimeRpcConnectionLimitFailure } from '../../shared/runtime-rpc-connection-limit'
import { RuntimeRpcEnvelopeSchema } from '../../shared/runtime-rpc-envelope'
import { formatCliError } from '../cli-error'
import { getCliStatus } from './status'
import { sendRequest } from './transport'
import { RuntimeRpcFailureError } from './types'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

type Reply = (id: string, attempt: number, method: string) => unknown

/** Fake runtime: answers each connection's request line with `reply`, then half-closes like the real busy path. */
async function startFakeRuntime(reply: Reply): Promise<{
  metadata: RuntimeMetadata
  userDataPath: string
  attempts: () => number
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-busy-retry-'))
  const endpoint = join(userDataPath, 'rt.sock')
  const sockets = new Set<Socket>()
  let attempts = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (chunk) => {
      attempts += 1
      const request = readRequest(String(chunk))
      socket.end(`${JSON.stringify(reply(request.id, attempts, request.method))}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const metadata: RuntimeMetadata = {
    runtimeId: 'rt-1',
    pid: process.pid,
    transports: [{ kind: 'unix', endpoint }],
    authToken: 'token',
    startedAt: 1
  }
  return { metadata, userDataPath, attempts: () => attempts }
}

function readRequest(raw: string): { id: string; method: string } {
  const parsed: unknown = JSON.parse(raw.trim())
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || !('method' in parsed)) {
    throw new Error(`unexpected request: ${raw}`)
  }
  return { id: String(parsed.id), method: String(parsed.method) }
}

const busy: Reply = (id) => buildRuntimeRpcConnectionLimitFailure(id)

describe('runtime connection-limit busy frame', () => {
  it('is a failure envelope every CLI decoder accepts', () => {
    expect(
      RuntimeRpcEnvelopeSchema.safeParse(buildRuntimeRpcConnectionLimitFailure('req-1')).success
    ).toBe(true)
  })

  it('formats with a retry step and no restart advice', () => {
    const text = formatCliError(
      new RuntimeRpcFailureError(buildRuntimeRpcConnectionLimitFailure('req-1'))
    )

    expect(text).toBe(
      'Orca is busy (connection limit); retry shortly.\nNext step: Retry the command in a few seconds.'
    )
    expect(text).not.toMatch(/Restart Orca|not running/)
  })
})

describe.skipIf(process.platform === 'win32')('CLI retry on connection-limit busy', () => {
  it('resends until the runtime admits the request', async () => {
    const runtime = await startFakeRuntime((id, attempt) =>
      attempt < 3
        ? busy(id, attempt, '')
        : { id, ok: true, result: {}, _meta: { runtimeId: 'rt-1' } }
    )

    const response = await sendRequest(runtime.metadata, 'linear.issue', {}, 60_000)

    expect(response.ok).toBe(true)
    expect(runtime.attempts()).toBe(3)
  })

  it('gives up after three resends and returns the busy failure', async () => {
    const runtime = await startFakeRuntime(busy)

    const response = await sendRequest(runtime.metadata, 'linear.issue', {}, 60_000)

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
    expect(runtime.attempts()).toBe(4)
  })

  it('does not resend once the caller timeout would lapse', async () => {
    const runtime = await startFakeRuntime(busy)

    const response = await sendRequest(runtime.metadata, 'status.get', undefined, 100)

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
    // The first backoff (>=125ms) already overruns a 100ms budget.
    expect(runtime.attempts()).toBe(1)
  })

  it('does not resend a runtime_busy that lacks the dispatched:false flag (long-poll admission)', async () => {
    const runtime = await startFakeRuntime((id) => ({
      id,
      ok: false,
      error: { code: 'runtime_busy', message: 'long-poll capacity reached; retry with backoff' },
      _meta: { runtimeId: 'rt-1' }
    }))

    const response = await sendRequest(runtime.metadata, 'orchestration.ask', undefined, 60_000)

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
    expect(runtime.attempts()).toBe(1)
  })

  it('reports a runtime that stays busy as reachable and busy, not starting', async () => {
    const runtime = await startFakeRuntime(busy)
    writeFileSync(getRuntimeMetadataPath(runtime.userDataPath), JSON.stringify(runtime.metadata))

    const status = await getCliStatus(runtime.userDataPath)

    expect(status.result.app).toEqual({ running: true, pid: process.pid })
    expect(status.result.runtime).toEqual({
      state: 'busy',
      reachable: true,
      connectionState: 'connected',
      runtimeId: 'rt-1'
    })
    expect(status.result.graph).toEqual({ state: 'unknown' })
  })
})
