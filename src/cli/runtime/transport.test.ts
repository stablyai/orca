import { mkdtempSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import type * as Net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { sendRequest } from './transport'

vi.mock('node:net', async (importOriginal) => {
  const net = await importOriginal<typeof Net>()
  return { ...net, createConnection: vi.fn(net.createConnection) }
})

const roots: string[] = []
const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function requestSocket(): Socket {
  const created = vi.mocked(createConnection).mock.results.at(-1)
  if (created?.type !== 'return') {
    throw new Error('Expected a local runtime connection')
  }
  return created.value
}

describe('runtime transport timeout validation', () => {
  it.each([-1, 1.5, MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timer delay %s before transport discovery',
    async (timeoutMs) => {
      const metadata: RuntimeMetadata = {
        runtimeId: 'runtime-1',
        pid: 123,
        transports: [],
        authToken: 'token',
        startedAt: 1
      }

      await expect(sendRequest(metadata, 'status.get', undefined, timeoutMs)).rejects.toMatchObject(
        {
          code: 'invalid_argument'
        }
      )
    }
  )
})

// These fixtures create Unix domain sockets rather than Windows named pipes.
describe.skipIf(process.platform === 'win32')('runtime transport', () => {
  it('refreshes the per-call timeout when the runtime sends keepalive frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    roots.push(userDataPath)
    const endpoint = join(userDataPath, 'runtime.sock')
    let acceptRequest!: (request: { id: string; peer: Socket }) => void
    const received = new Promise<{ id: string; peer: Socket }>((resolve) => {
      acceptRequest = resolve
    })
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request: { id: string } = JSON.parse(String(data).trim())
        acceptRequest({ id: request.id, peer: socket })
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const response = sendRequest<{ satisfied: boolean }>(
      metadata,
      'terminal.wait',
      undefined,
      200
    ).then(
      (value) => ({ response: value }),
      (error: unknown) => ({ error })
    )
    const client = requestSocket()
    const { id, peer } = await received
    await vi.advanceTimersByTimeAsync(150)
    const keepalive = once(client, 'data')
    peer.write('{"_keepalive":true}\n')
    await keepalive
    await vi.advanceTimersByTimeAsync(150)
    peer.write(
      `${JSON.stringify({ id, ok: true, result: { satisfied: true }, _meta: { runtimeId: 'runtime-1' } })}\n`
    )

    expect(await response).toMatchObject({
      response: { ok: true, result: { satisfied: true } }
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects promptly when the runtime closes the socket before responding', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    roots.push(userDataPath)
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => socket.end())
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const response = sendRequest(metadata, 'status.get', undefined, 60000).catch(
      (error: unknown) => error
    )
    await once(requestSocket(), 'close')
    await vi.runAllTimersAsync()
    expect(await response).toMatchObject({
      code: 'runtime_unavailable',
      message:
        'The Orca runtime closed the connection before responding. Restart Orca and try again.'
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
