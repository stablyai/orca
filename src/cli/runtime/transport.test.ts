import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { sendRequest } from './transport'

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

// Why: these tests create Unix domain socket servers in temp directories.
// Windows does not support Unix domain sockets in the same way.
describe.skipIf(process.platform === 'win32')('runtime transport', () => {
  it('refreshes the per-call timeout when the runtime sends keepalive frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      let keepalive: ReturnType<typeof setInterval> | null = null
      socket.once('close', () => {
        sockets.delete(socket)
        if (keepalive) {
          clearInterval(keepalive)
        }
      })
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        // Why: full-suite load can delay short timers; keep the response past
        // the client timeout while leaving enough margin between keepalives.
        keepalive = setInterval(() => {
          socket.write('{"_keepalive":true}\n')
        }, 50)
        setTimeout(() => {
          if (keepalive) {
            clearInterval(keepalive)
            keepalive = null
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { satisfied: true },
              _meta: { runtimeId: 'runtime-1' }
            })}\n`
          )
        }, 500)
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
    const response = await sendRequest<{ satisfied: boolean }>(
      metadata,
      'terminal.wait',
      undefined,
      200
    )

    expect(response).toMatchObject({
      ok: true,
      result: { satisfied: true }
    })
  })

  it('keeps terminal tab close timeouts absolute despite keepalive frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      let keepalive: ReturnType<typeof setInterval> | null = null
      let stopKeepalive: ReturnType<typeof setTimeout> | null = null
      socket.once('close', () => {
        sockets.delete(socket)
        if (keepalive) {
          clearInterval(keepalive)
        }
        if (stopKeepalive) {
          clearTimeout(stopKeepalive)
        }
      })
      socket.once('data', () => {
        keepalive = setInterval(() => socket.write('{"_keepalive":true}\n'), 50)
        stopKeepalive = setTimeout(() => {
          if (keepalive) {
            clearInterval(keepalive)
            keepalive = null
          }
        }, 400)
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
    const startedAt = Date.now()

    await expect(sendRequest(metadata, 'terminal.closeTab', undefined, 200)).rejects.toMatchObject({
      code: 'runtime_timeout'
    })
    expect(Date.now() - startedAt).toBeLessThan(350)
  })

  it('rejects promptly when the runtime closes the socket before responding', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      // Read the request, then close cleanly without writing a terminal frame.
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

    // A generous timeout: a passing fix rejects on close well before this; the
    // pre-fix behavior would hang the full duration and trip vitest's own limit.
    const start = Date.now()
    await expect(sendRequest(metadata, 'status.get', undefined, 60000)).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
    expect(Date.now() - start).toBeLessThan(5000)
  })
})
