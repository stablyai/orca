import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClient } from './client'
import { projectRemoteAppStatus } from './status'

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
      state: 'ready',
      degradations: [expect.objectContaining({ code: 'browser_unavailable' })]
    })
  })
})

describe('projectRemoteAppStatus', () => {
  function remoteStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
    return {
      runtimeId: 'remote-runtime',
      graphStatus: 'ready',
      authoritativeWindowId: null,
      ...overrides
    } as RuntimeStatus
  }

  // STA-4792 defect 4: the reported output was running:false alongside desktopWindowStatus
  // 'available', while the target's GUI was demonstrably up.
  it('reports the target app as running when a renderer owns the graph there', () => {
    expect(projectRemoteAppStatus(remoteStatus({ desktopWindowStatus: 'available' }))).toEqual({
      running: true,
      pid: null,
      desktopWindowStatus: 'available'
    })
  })

  it.each(['openable', 'initializing', 'blocked'] as const)(
    'does not claim a running desktop for window status %s',
    (desktopWindowStatus) => {
      expect(projectRemoteAppStatus(remoteStatus({ desktopWindowStatus })).running).toBe(false)
    }
  )

  // A headless `serve` reports no window at all.
  it('reports not running when the target has no desktop window status', () => {
    expect(projectRemoteAppStatus(remoteStatus())).toEqual({ running: false, pid: null })
  })

  // Why: old runtimes predate the explicit status but a positive window id still proves a window.
  it('honors the authoritativeWindowId fallback for older runtimes', () => {
    expect(projectRemoteAppStatus(remoteStatus({ authoritativeWindowId: 3 }))).toEqual({
      running: true,
      pid: null,
      desktopWindowStatus: 'available'
    })
  })

  // Why: the SSH host-passthrough answers for the Orca host the caller reached, and used to
  // claim running:true unconditionally. Both transports now share this projection.
  it('does not claim a desktop app for a headless serve on any transport', () => {
    expect(projectRemoteAppStatus(remoteStatus({ desktopWindowStatus: 'openable' }))).toEqual({
      running: false,
      pid: null,
      desktopWindowStatus: 'openable'
    })
  })

  it('never reports a remote pid', () => {
    expect(
      projectRemoteAppStatus(remoteStatus({ desktopWindowStatus: 'available' })).pid
    ).toBeNull()
  })
})
