import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { openLocalRuntimeStream } from './local-stream-transport'

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
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
})

describe.skipIf(process.platform === 'win32')('local runtime stream transport', () => {
  it('opts into streaming and forwards every response frame', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-local-stream-')), 'runtime.sock')
    let request: Record<string, unknown> | null = null
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        request = JSON.parse(String(data).trim()) as Record<string, unknown>
        const id = request.id
        for (const result of [
          { type: 'scrollback', serialized: 'ready' },
          { type: 'data', chunk: '\u0003raw' },
          { type: 'end' }
        ]) {
          socket.write(
            `${JSON.stringify({ id, ok: true, result, _meta: { runtimeId: 'runtime-1' } })}\n`
          )
        }
        socket.end()
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const events: unknown[] = []
    const stream = openLocalRuntimeStream(
      metadata(endpoint),
      'terminal.subscribe',
      { terminal: 'term-1' },
      1000,
      (response) => events.push(response.result)
    )
    await stream.done

    expect(request).toMatchObject({
      method: 'terminal.subscribe',
      params: { terminal: 'term-1' },
      stream: true
    })
    expect(events).toEqual([
      { type: 'scrollback', serialized: 'ready' },
      { type: 'data', chunk: '\u0003raw' },
      { type: 'end' }
    ])
  })

  it('rejects EOF after data when the runtime omits the protocol end frame', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-local-stream-')), 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { type: 'scrollback', serialized: 'ready' },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const stream = openLocalRuntimeStream(
      metadata(endpoint),
      'terminal.subscribe',
      { terminal: 'term-1' },
      1000,
      () => {}
    )

    await expect(stream.done).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })

  it('closes an idle stream without reporting a transport failure', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-local-stream-')), 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const stream = openLocalRuntimeStream(
      metadata(endpoint),
      'terminal.subscribe',
      { terminal: 'term-1' },
      1000,
      () => {}
    )
    stream.close()
    await expect(stream.done).resolves.toBeUndefined()
  })

  it('keeps an intentional close clean after receiving stream data', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-local-stream-')), 'runtime.sock')
    let release = (): void => {}
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { type: 'scrollback', serialized: 'ready' },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
        release = () => socket.end()
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const events: unknown[] = []
    const stream = openLocalRuntimeStream(
      metadata(endpoint),
      'terminal.subscribe',
      { terminal: 'term-1' },
      1000,
      (response) => events.push(response.result)
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))
    stream.close()
    release()
    await expect(stream.done).resolves.toBeUndefined()
  })
})

function metadata(endpoint: string): RuntimeMetadata {
  return {
    runtimeId: 'runtime-1',
    pid: 123,
    transports: [{ kind: 'unix', endpoint }],
    authToken: 'token',
    startedAt: 1
  }
}
