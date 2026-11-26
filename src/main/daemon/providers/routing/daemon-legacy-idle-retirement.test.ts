import '../../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonServer } from '../../server/daemon-server'
import { DaemonClient } from '../../transport/client/daemon-client'
import { getDaemonSocketPath } from '../../launch/daemon-spawner'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonLegacyIdleRetirement } from './daemon-legacy-idle-retirement'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function subprocess(): SubprocessHandle & { exit(): void } {
  let onExit: ((code: number) => void) | undefined
  const exit = (): void => onExit?.(0)
  return {
    pid: 44445,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: exit,
    forceKill: exit,
    terminateOwnedTree: () => 'unavailable',
    signal() {},
    onData() {},
    onExit(callback) {
      onExit = callback
    },
    dispose() {},
    exit
  }
}

describe.skipIf(process.platform === 'win32')('empty legacy daemon retirement', () => {
  const dirs: string[] = []
  const servers: DaemonServer[] = []
  const adapters: DaemonPtyAdapter[] = []
  const clients: DaemonClient[] = []
  const routers: DaemonPtyRouter[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const router of routers.splice(0)) {
      router.disposeRouterOnly()
    }
    for (const client of clients.splice(0)) {
      client.disconnect()
    }
    for (const adapter of adapters.splice(0)) {
      await adapter.disconnectOnly()
    }
    for (const server of servers.splice(0)) {
      await server.shutdown()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function daemon(version: number) {
    const dir = mkdtempSync(join(tmpdir(), 'orca-idle-legacy-'))
    dirs.push(dir)
    const socketPath = getDaemonSocketPath(dir, version)
    const tokenPath = join(dir, 'token')
    const children: ReturnType<typeof subprocess>[] = []
    let stopped!: () => void
    const shutdown = new Promise<void>((resolve) => (stopped = resolve))
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion: version,
      onIdleShutdown: stopped,
      spawnSubprocess: () => {
        const child = subprocess()
        children.push(child)
        return child
      }
    })
    servers.push(server)
    await server.start()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: version })
    adapters.push(adapter)
    return { server, adapter, socketPath, tokenPath, children, shutdown, dir }
  }

  function router(current: DaemonPtyAdapter, legacy: DaemonPtyAdapter) {
    const result = new DaemonPtyRouter({ current, legacy: [legacy] })
    routers.push(result)
    return result
  }

  it('retires an empty legacy host while preserving the current host and its live session', async () => {
    const current = await daemon(62)
    const legacy = await daemon(61)
    await current.adapter.spawn({ sessionId: 'current', cols: 80, rows: 24, cwd: current.dir })
    const routed = router(current.adapter, legacy.adapter)

    await routed.discoverLegacySessions()

    expect(legacy.adapter.hasRetiredForIdle()).toBe(true)
    expect(current.adapter.hasRetiredForIdle()).toBe(false)
    expect((await current.adapter.listSessions()).map((session) => session.sessionId)).toEqual([
      'current'
    ])
    expect(routed.getLegacyAdapters()).toContain(legacy.adapter)
    await legacy.shutdown
  })

  it('preserves a live legacy session and retires its host after the last session exits', async () => {
    const current = await daemon(62)
    const legacy = await daemon(61)
    await legacy.adapter.spawn({ sessionId: 'legacy', cols: 80, rows: 24, cwd: legacy.dir })
    const routed = router(current.adapter, legacy.adapter)
    await routed.discoverLegacySessions()
    expect(legacy.adapter.hasRetiredForIdle()).toBe(false)

    legacy.children[0].exit()
    await legacy.shutdown

    expect(current.adapter.hasRetiredForIdle()).toBe(false)
  })

  it('keeps an empty host serving another client and can retire it when that client leaves', async () => {
    const current = await daemon(62)
    const legacy = await daemon(61)
    const other = new DaemonClient({
      socketPath: legacy.socketPath,
      tokenPath: legacy.tokenPath,
      protocolVersion: 61
    })
    clients.push(other)
    await other.ensureConnected()
    const routed = router(current.adapter, legacy.adapter)
    await routed.discoverLegacySessions()

    expect(legacy.adapter.hasRetiredForIdle()).toBe(false)
    expect(legacy.adapter.isIdleRetirementAdmissionClosed()).toBe(false)
    await expect(other.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })

    other.disconnect()
    await routed.listProcesses()
    await legacy.shutdown
  })

  it('retires a detached legacy session after its exit is observed by a full census', async () => {
    const current = await daemon(62)
    const legacy = await daemon(61)
    await legacy.adapter.spawn({ sessionId: 'detached', cols: 80, rows: 24, cwd: legacy.dir })
    const observer = new DaemonPtyAdapter({
      socketPath: legacy.socketPath,
      tokenPath: legacy.tokenPath,
      protocolVersion: 61
    })
    adapters.push(observer)
    const routed = router(current.adapter, observer)
    await routed.discoverLegacySessions()
    await legacy.adapter.disconnectOnly()

    legacy.children[0].exit()
    await routed.listProcesses()
    await legacy.shutdown

    expect(current.adapter.hasRetiredForIdle()).toBe(false)
  })

  it('rechecks a coalesced last exit instead of accepting the earlier live inventory', async () => {
    const legacy = await daemon(61)
    await legacy.adapter.spawn({ sessionId: 'legacy', cols: 80, rows: 24, cwd: legacy.dir })
    const retirement = new DaemonLegacyIdleRetirement((adapter) => adapter === legacy.adapter)
    const observed = deferred<void>()
    const release = deferred<void>()
    const list = legacy.adapter.listSessions.bind(legacy.adapter)
    vi.spyOn(legacy.adapter, 'listSessions').mockImplementationOnce(async () => {
      const snapshot = await list()
      observed.resolve()
      await release.promise
      return snapshot
    })
    const first = retirement.request(legacy.adapter)
    await observed.promise
    legacy.children[0].exit()
    const lastExit = retirement.request(legacy.adapter)
    expect(lastExit).toBe(first)
    release.resolve()
    await lastExit

    expect(legacy.adapter.hasRetiredForIdle()).toBe(true)
    await legacy.shutdown
  })

  it('does not retire an adapter reused after its old router is disposed', async () => {
    const current = await daemon(62)
    const legacy = await daemon(61)
    const routed = router(current.adapter, legacy.adapter)
    const observed = deferred<void>()
    const release = deferred<void>()
    const list = legacy.adapter.listSessions.bind(legacy.adapter)
    vi.spyOn(legacy.adapter, 'listSessions').mockImplementationOnce(async () => {
      const snapshot = await list()
      observed.resolve()
      await release.promise
      return snapshot
    })
    const discovery = routed.discoverLegacySessions()
    await observed.promise
    routed.disposeRouterOnly()
    router(current.adapter, legacy.adapter)
    release.resolve()
    await discovery

    expect(legacy.adapter.hasRetiredForIdle()).toBe(false)
    await legacy.adapter.spawn({ sessionId: 'reused', cols: 80, rows: 24, cwd: legacy.dir })
    expect((await legacy.adapter.listSessions()).map((session) => session.sessionId)).toEqual([
      'reused'
    ])
  })

  it('preserves a session created after the empty census through the atomic host check', async () => {
    const legacy = await daemon(61)
    const retirement = new DaemonLegacyIdleRetirement((adapter) => adapter === legacy.adapter)
    const list = legacy.adapter.listSessions.bind(legacy.adapter)
    vi.spyOn(legacy.adapter, 'listSessions').mockImplementationOnce(async () => {
      const snapshot = await list()
      await legacy.adapter.spawn({ sessionId: 'racing', cols: 80, rows: 24, cwd: legacy.dir })
      return snapshot
    })

    await retirement.request(legacy.adapter)

    expect(legacy.adapter.hasRetiredForIdle()).toBe(false)
    expect(legacy.adapter.isIdleRetirementAdmissionClosed()).toBe(false)
    expect((await legacy.adapter.listSessions()).map((session) => session.sessionId)).toEqual([
      'racing'
    ])
  })

  it('does not retry an ambiguous retirement or reopen its admission fence', async () => {
    const legacy = await daemon(61)
    const retirement = new DaemonLegacyIdleRetirement((adapter) => adapter === legacy.adapter)
    const request = DaemonClient.prototype.request
    const fault = vi.spyOn(DaemonClient.prototype, 'request').mockImplementation(function (
      this: DaemonClient,
      type,
      payload,
      timeout
    ) {
      if (type === 'shutdownIfIdle') {
        return Promise.reject(new Error('reply lost'))
      }
      return request.call(this, type, payload, timeout)
    })
    await retirement.request(legacy.adapter)
    fault.mockRestore()
    expect(legacy.adapter.isIdleRetirementAdmissionClosed()).toBe(true)

    await retirement.request(legacy.adapter)

    expect(legacy.adapter.hasRetiredForIdle()).toBe(false)
    expect(legacy.adapter.isIdleRetirementAdmissionClosed()).toBe(true)
  })
})
