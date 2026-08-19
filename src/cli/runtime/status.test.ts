import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { RuntimeClient } from './client'
import { getCliStatus } from './status'

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
  vi.restoreAllMocks()
})

// Why: legacy runtime metadata compatibility only applies to local Unix socket
// metadata; Windows uses named pipes and cannot run this fixture directly.
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
              liveTabCount: 0
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
        pid: process.pid,
        transport: { kind: 'unix', endpoint },
        authToken: 'token',
        startedAt: Date.now()
      })
    )

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime).toMatchObject({
      reachable: true,
      runtimeId: 'runtime-legacy',
      state: 'ready'
    })
  })

  function writeUnreachableMetadata(prefix: string, pid: number): string {
    const userDataPath = mkdtempSync(join(tmpdir(), prefix))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: 'runtime-foreign',
        pid,
        transport: { kind: 'unix', endpoint: join(userDataPath, 'never-listening.sock') },
        authToken: 'token',
        startedAt: Date.now()
      })
    )
    return userDataPath
  }

  function throwFromKill(code: string, errno: number): void {
    // Why: a real pid would make the branch environment-dependent — as root, or
    // in a container, a "foreign" pid answers normally and the test passes
    // without ever reaching the errno it claims to cover. The errno matters:
    // Node attaches one to syscall failures and none to argument rejections.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code, errno })
    })
  }

  it('treats an unreachable runtime owned by another user as running', async () => {
    // Why: EPERM means the pid exists but belongs to another user (a root
    // supervisor, or a serve under a different account). Reporting that profile
    // as stale tells the user to clean up a runtime that is still there.
    throwFromKill('EPERM', -1)

    const status = await getCliStatus(writeUnreachableMetadata('orca-runtime-status-eperm-', 4242))

    expect(status.result.app).toMatchObject({ running: true, pid: 4242 })
    expect(status.result.runtime.state).toBe('starting')
  })

  it('does not read a pid the OS rejects outright as a live owner', async () => {
    // Why: process.kill throws a TypeError with no errno for a non-integer pid,
    // and "not ESRCH" alone would call that alive — a corrupt metadata file
    // would then be reported as a running app that cannot be found or stopped.
    const status = await getCliStatus(writeUnreachableMetadata('orca-runtime-status-badpid-', 1.5))

    expect(status.result.app).toMatchObject({ running: false, pid: null })
    expect(status.result.runtime.state).toBe('stale_bootstrap')
  })

  it('still reports a runtime whose pid is gone as stale', async () => {
    // Why: only ESRCH proves death — without this the widened rule would call
    // every dead profile "starting" and never report a stale one.
    throwFromKill('ESRCH', -3)

    const status = await getCliStatus(writeUnreachableMetadata('orca-runtime-status-esrch-', 4242))

    expect(status.result.app).toMatchObject({ running: false, pid: null })
    expect(status.result.runtime.state).toBe('stale_bootstrap')
  })
})
