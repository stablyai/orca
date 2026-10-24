import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter.replaceIdleDaemonForFreshSpawns', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let respawnServer: DaemonServer | undefined

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    respawnServer = undefined
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    await respawnServer?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  function replacingRespawn() {
    return vi.fn(async () => {
      await server.shutdown()
      rmSync(socketPath, { force: true })
      respawnServer = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await respawnServer.start()
    })
  }

  it('replaces a daemon with no live sessions and reconnects to the replacement', async () => {
    const respawnFn = replacingRespawn()
    const idleAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

    await expect(idleAdapter.replaceIdleDaemonForFreshSpawns()).resolves.toBe(true)

    expect(respawnFn).toHaveBeenCalledExactlyOnceWith('failed_health_check')
    const next = await idleAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })
    expect(next.id).toBeDefined()
    idleAdapter.dispose()
  })

  it('keeps a daemon that still owns a live session', async () => {
    const respawnFn = replacingRespawn()
    const busyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
    await busyAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

    await expect(busyAdapter.replaceIdleDaemonForFreshSpawns()).resolves.toBe(false)

    expect(respawnFn).not.toHaveBeenCalled()
    busyAdapter.dispose()
  })

  it('keeps a daemon whose live session inventory is unavailable', async () => {
    const respawnFn = replacingRespawn()
    const blindAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
    const internals = blindAdapter as unknown as {
      client: { request: (type: string, payload?: unknown) => Promise<unknown> }
    }
    const originalRequest = internals.client.request.bind(internals.client)
    vi.spyOn(internals.client, 'request').mockImplementation((type, payload) =>
      type === 'listSessions'
        ? Promise.reject(new Error('inventory unavailable'))
        : originalRequest(type, payload)
    )

    await expect(blindAdapter.replaceIdleDaemonForFreshSpawns()).resolves.toBe(false)

    expect(respawnFn).not.toHaveBeenCalled()
    blindAdapter.dispose()
  })

  it('never replaces without a respawn path', async () => {
    await expect(adapter.replaceIdleDaemonForFreshSpawns()).resolves.toBe(false)
  })
})
