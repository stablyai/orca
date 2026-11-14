import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { RuntimeClient } from './client'

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

// This legacy fixture uses Unix sockets; Windows runtimes use named pipes.
describe.skipIf(process.platform === 'win32')('CLI runtime status', () => {
  it('uses the legacy singular runtime transport when reporting status', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-'))
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
            result: {
              runtimeId: 'runtime-legacy',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              degradations: [
                {
                  code: 'browser_unavailable',
                  capability: 'browser.headless.v1',
                  message: 'Browser automation is unavailable.'
                }
              ]
            },
            _meta: { runtimeId: 'runtime-legacy' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: 'runtime-legacy',
        pid: 424242,
        transport: { kind: 'unix', endpoint },
        authToken: 'token',
        startedAt: 1
      })
    )

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime).toMatchObject({
      reachable: true,
      connectionState: 'connected',
      runtimeId: 'runtime-legacy',
      state: 'ready',
      degradations: [expect.objectContaining({ code: 'browser_unavailable' })]
    })
  })
})

// A persisted host PID cannot establish liveness in the caller's namespace.
describe.skipIf(process.platform === 'win32')('CLI status connection authority', () => {
  it('reports an unavailable endpoint without using a PID probe', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-probe-'))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: 'runtime-unreachable',
        pid: 424242,
        transport: { kind: 'unix', endpoint: join(userDataPath, 'absent.sock') },
        authToken: 'token',
        startedAt: 1
      })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('unexpected PID probe')
    })
    try {
      await expect(new RuntimeClient(userDataPath).getCliStatus()).rejects.toMatchObject({
        code: 'runtime_unavailable'
      })
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it('reports a status timeout from a live listener without declaring its hidden PID dead', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-status-timeout-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.resume()
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: 'runtime-timeout',
        pid: 424242,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: 1
      })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('hidden PID'), { code: 'ESRCH' })
    })
    try {
      await expect(new RuntimeClient(userDataPath).getCliStatus()).rejects.toMatchObject({
        code: 'runtime_timeout'
      })
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })
})
