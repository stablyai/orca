import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import '../../shared/protocol-version'
import { RuntimeClient } from './client'
import { launchOrcaApp } from './launch'
import '../output/cli-error'

vi.mock('./launch', () => ({
  launchOrcaApp: vi.fn()
}))

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  vi.useRealTimers()
  vi.mocked(launchOrcaApp).mockClear()
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

function makeRuntimeClientFixture(): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
  onTestFinished(() => rmSync(userDataPath, { recursive: true, force: true }))
  return userDataPath
}

function writeMetadata(
  userDataPath: string,
  endpoint: string,
  authToken = 'token',
  pid = 123
): void {
  writeFileSync(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-1',
      pid,
      transports: [
        {
          kind: 'unix',
          endpoint
        }
      ],
      authToken,
      startedAt: 1
    }),
    'utf8'
  )
}

// Temp-path Unix sockets fail with EACCES on Windows.
describe.skipIf(process.platform === 'win32')('RuntimeClient', () => {
  it('rejects an old local runtime before sending an orchestration mutation', async () => {
    const userDataPath = makeRuntimeClientFixture()
    const endpoint = join(userDataPath, 'runtime.sock')
    const requests: Record<string, unknown>[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as Record<string, unknown>
        requests.push(request)
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { capabilities: [] },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 500)
    await expect(client.call('orchestration.send', { subject: 'hello' })).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: {
        reason: 'runtime_capability_missing',
        effectsApplied: false,
        nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
      }
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('status.get')
  })

  it('times out if the runtime never responds', async () => {
    const userDataPath = makeRuntimeClientFixture()
    const endpoint = join(userDataPath, 'runtime.sock')
    const received = Promise.withResolvers<void>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => received.resolve())
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const client = new RuntimeClient(userDataPath, 25)
    const failure = expect(client.call('status.get')).rejects.toMatchObject({
      code: 'runtime_timeout'
    })
    await received.promise
    await vi.advanceTimersByTimeAsync(25)
    await failure
  })

  it('rejects mismatched response ids from the runtime', async () => {
    const userDataPath = makeRuntimeClientFixture()
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => {
        socket.write(
          `${JSON.stringify({
            id: 'not-the-request-id',
            ok: true,
            result: { running: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 100)

    await expect(client.call('status.get')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
  })

  it.each(['x'.repeat(1024 * 1024), 'é'.repeat(512 * 1024)])(
    'refuses oversized serialized requests before sending any bytes',
    async (body) => {
      const userDataPath = makeRuntimeClientFixture()
      const endpoint = join(userDataPath, 'runtime.sock')
      const received = vi.fn()
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('data', received)
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      writeMetadata(userDataPath, endpoint)

      // A write-then-reject can settle before the server emits data.
      const serverClosed = new Promise<void>((resolve) =>
        server.once('connection', (socket) => socket.once('close', () => resolve()))
      )
      const client = new RuntimeClient(userDataPath, 1000)
      await expect(client.call('status.get', { body })).rejects.toMatchObject({
        code: 'invalid_argument',
        data: { effectsApplied: false, requestSent: false }
      })
      await serverClosed
      expect(received).not.toHaveBeenCalled()
    }
  )
})
