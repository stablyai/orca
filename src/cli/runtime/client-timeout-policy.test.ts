import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client'
import { resolveRuntimeClientTimeoutMs } from './client-timeout-policy'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

describe('RuntimeClient dispatch timeout policy', () => {
  it('adds long-poll grace only to injected non-preview dispatches', () => {
    expect(resolveRuntimeClientTimeoutMs('orchestration.dispatch', { inject: true }, 1_000)).toBe(
      70_000
    )
    expect(
      resolveRuntimeClientTimeoutMs('orchestration.dispatch', { inject: true, dryRun: true }, 1_000)
    ).toBe(1_000)
    expect(resolveRuntimeClientTimeoutMs('orchestration.dispatch', { inject: false }, 1_000)).toBe(
      1_000
    )
  })

  it('adds readiness grace to local and federated worker starts', () => {
    expect(resolveRuntimeClientTimeoutMs('orchestration.workerStart', {}, 1_000)).toBe(70_000)
    expect(
      resolveRuntimeClientTimeoutMs('orchestration.workerStart', { timeoutMs: 5_000 }, 1_000)
    ).toBe(15_000)
    expect(
      resolveRuntimeClientTimeoutMs(
        'orchestration.federationAttachStart',
        { timeoutMs: 8_000 },
        1_000
      )
    ).toBe(18_000)
  })
})

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

describe.skipIf(process.platform === 'win32')('RuntimeClient timeout policy', () => {
  it('does not crash while resolving terminal.wait defaults without params', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { satisfied: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 100)
    const response = await client.call<{ satisfied: boolean }>('terminal.wait')

    expect(response.result).toEqual({ satisfied: true })
  })
})
