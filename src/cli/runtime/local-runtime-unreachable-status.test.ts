import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { formatCliStatus } from '../format'
import { RuntimeClient } from './client'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
})

function seedMetadata(endpoint: string, pid: number): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-unreachable-'))
  writeFileSync(
    getRuntimeMetadataPath(userDataPath),
    JSON.stringify({
      runtimeId: 'runtime-under-test',
      pid,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: Date.now()
    })
  )
  return userDataPath
}

async function listen(endpoint: string, onConnection: (socket: Socket) => void): Promise<void> {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    onConnection(socket)
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
}

// Why: Windows publishes named pipes, which these Unix-socket fixtures cannot stand in for.
// The classification itself is platform-independent and covered by the reason unit tests.
describe.skipIf(process.platform === 'win32')('local runtime reachability status', () => {
  // STA-3969: the reported incident. The Orca app process is alive and metadata
  // names an endpoint, but the CLI cannot open it — reported for weeks as
  // `starting`, which told the user to keep waiting for a start that had already
  // happened. The runtime writes this metadata only after its transport is
  // listening, so `starting` is never a truthful reading here.
  it('names the missing endpoint instead of claiming the runtime is still starting', async () => {
    const userDataPath = seedMetadata(
      join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'gone.sock'),
      process.pid
    )

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.app).toMatchObject({ running: true, pid: process.pid })
    expect(status.result.runtime.state).toBe('unreachable')
    expect(status.result.runtime.reachable).toBe(false)
    expect(status.result.graph.state).toBe('unreachable')
    expect(status.result.runtime.unreachableReason).toMatchObject({
      code: 'endpoint_missing',
      osErrorCode: 'ENOENT'
    })
    expect(status.result.runtime.unreachableReason?.message).toContain('gone.sock')
  })

  it('reports a runtime that closes the connection before replying', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'closes.sock')
    await listen(endpoint, (socket) => socket.destroy())
    const userDataPath = seedMetadata(endpoint, process.pid)

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime.state).toBe('unreachable')
    expect(status.result.runtime.unreachableReason?.code).toBe('connection_closed')
  })

  // Why: `socket.destroy()` above surfaces as an ECONNRESET on the client's error
  // handler. A clean FIN with no reply takes the separate 'close' path, which has
  // no errno at all — it is classified by transport phase, so it needs its own case.
  it('reports a runtime that half-closes cleanly without replying', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'fin.sock')
    await listen(endpoint, (socket) => {
      socket.once('data', () => socket.end())
    })
    const userDataPath = seedMetadata(endpoint, process.pid)

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime.state).toBe('unreachable')
    expect(status.result.runtime.unreachableReason).toMatchObject({ code: 'connection_closed' })
    expect(status.result.runtime.unreachableReason?.osErrorCode).toBeUndefined()
  })

  it('reports a runtime that accepts the connection but never answers', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'silent.sock')
    await listen(endpoint, () => {})
    const userDataPath = seedMetadata(endpoint, process.pid)

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime.state).toBe('unreachable')
    expect(status.result.runtime.unreachableReason?.code).toBe('request_timeout')
    expect(status.result.runtime.unreachableReason?.message).toContain('rather than starting')
  })

  it('separates a runtime that answers and refuses from one it cannot reach', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'refuses.sock')
    await listen(endpoint, (socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'unauthorized', message: 'Auth token is not valid for this runtime.' },
            _meta: { runtimeId: 'runtime-under-test' }
          })}\n`
        )
      })
    })
    const userDataPath = seedMetadata(endpoint, process.pid)

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime.unreachableReason?.code).toBe('request_rejected')
    expect(status.result.runtime.unreachableReason?.message).toContain(
      'Auth token is not valid for this runtime.'
    )
  })

  // Preservation: a dead pid is still a stale bootstrap, not an unreachable runtime.
  it('still reports a stale bootstrap when the recorded process is gone', async () => {
    const userDataPath = seedMetadata(
      join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'dead.sock'),
      2 ** 30
    )

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime.state).toBe('stale_bootstrap')
    expect(status.result.runtime.unreachableReason).toBeUndefined()
    expect(status.result.app).toMatchObject({ running: false, pid: null })
  })

  // Why: the default `orca status` output is plain text, so the cause has to reach
  // the non-JSON reader too — that is the surface the report was read from.
  it('prints the cause in the plain-text status output', async () => {
    const userDataPath = seedMetadata(
      join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'gone.sock'),
      process.pid
    )

    const text = formatCliStatus((await new RuntimeClient(userDataPath).getCliStatus()).result)

    expect(text).toContain('runtimeState: unreachable')
    expect(text).toContain('unreachableCode: endpoint_missing')
    expect(text).toContain('unreachableDetail: ')
    expect(text).toContain('gone.sock')
  })

  // Constraint: nothing may report a runtime as usable when it is not.
  it('never reports a reachable or ready runtime while the endpoint is unusable', async () => {
    const userDataPath = seedMetadata(
      join(mkdtempSync(join(tmpdir(), 'orca-ep-')), 'gone.sock'),
      process.pid
    )

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime.reachable).toBe(false)
    expect(status.result.runtime.state).not.toBe('ready')
    expect(status.result.runtime.runtimeId).toBeNull()
    expect(status._meta?.runtimeId).toBe('none')
  })
})
