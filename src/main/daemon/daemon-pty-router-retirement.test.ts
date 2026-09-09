import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { waitForEndpointUnreachable } from './daemon-endpoint-reachability-test-harness'
import type { SubprocessHandle } from './session-subprocess-handle'

function subprocess(): SubprocessHandle & { exit(): void; output(data: string): void } {
  let exit: ((code: number) => void) | undefined
  let data: ((data: string) => void) | undefined
  return {
    pid: 999_999_999,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: () => setTimeout(() => exit?.(0), 0),
    forceKill: () => setTimeout(() => exit?.(137), 0),
    terminateOwnedTree: () => 'unavailable',
    signal: vi.fn(),
    dispose: vi.fn(),
    onData: (callback) => {
      data = callback
    },
    onExit: (callback) => {
      exit = callback
    },
    exit: () => exit?.(0),
    output: (value) => data?.(value)
  }
}

function clientFor(adapter: DaemonPtyAdapter): DaemonClient {
  return (adapter as unknown as { client: DaemonClient }).client
}

describe('shipping router legacy retirement', () => {
  let dir: string
  let legacy: DaemonPtyAdapter
  let current: DaemonPtyAdapter
  let router: DaemonPtyRouter
  let legacyServer: DaemonServer
  let currentServer: DaemonServer
  let child: ReturnType<typeof subprocess>
  let children: Map<string, ReturnType<typeof subprocess>>
  let peer: DaemonClient | undefined
  let raw: Socket | undefined

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-router-retirement-'))
    const historyPath = join(dir, 'history')
    child = subprocess()
    children = new Map()
    const log = { log: () => {}, close: () => {} }
    legacyServer = new DaemonServer({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29,
      spawnSubprocess: (options) => {
        const owned = children.size === 0 ? child : subprocess()
        children.set(options.sessionId, owned)
        return owned
      },
      log
    })
    currentServer = new DaemonServer({
      socketPath: getDaemonSocketPath(dir, 36),
      tokenPath: join(dir, 'current.token'),
      protocolVersion: 36,
      spawnSubprocess: subprocess,
      log
    })
    await Promise.all([legacyServer.start(), currentServer.start()])
    legacy = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29,
      historyPath
    })
    current = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir, 36),
      tokenPath: join(dir, 'current.token'),
      protocolVersion: 36,
      historyPath
    })
    router = new DaemonPtyRouter({ current, legacy: [legacy] })
  })

  afterEach(async () => {
    raw?.destroy()
    raw = undefined
    peer?.disconnect()
    peer = undefined
    router.disposeRouterOnly()
    legacy.dispose()
    current.dispose()
    child.exit()
    for (const owned of children.values()) {
      owned.exit()
    }
    await Promise.all([legacyServer.shutdown(), currentServer.shutdown()])
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function assertRetired(): Promise<void> {
    await vi.waitFor(() => expect(router.getLegacyAdapters()).toEqual([]))
    expect(await waitForEndpointUnreachable(getDaemonSocketPath(dir, 29))).toBe(true)
    await expect(router.listProcesses()).resolves.toEqual([])
    await expect(router.probePtyLiveness('missing')).resolves.toBe(false)
  }

  it('retires empty adoption and removes the adapter from every aggregate', async () => {
    const dispose = vi.spyOn(legacy, 'dispose')
    const request = vi.spyOn(clientFor(legacy), 'request')
    await router.discoverLegacySessions()
    await assertRetired()
    expect(request.mock.calls.some(([type]) => type === 'shutdownIfIdle')).toBe(true)
    expect(dispose).not.toHaveBeenCalled()
    expect(router.getAllAdapters()).toEqual([current])
  })

  it.each(['repo::path::workspace:git:tab', 'folder:fixture:tab', 'floating-fixture'])(
    'keeps %s live and retires on its actual exit',
    async (sessionId) => {
      await legacy.spawn({ sessionId, cols: 80, rows: 24 })
      await router.discoverLegacySessions()
      expect(router.getLegacyAdapters()).toEqual([legacy])
      const exited = vi.fn()
      router.onExit(exited)
      child.exit()
      await assertRetired()
      expect(exited).toHaveBeenCalledWith(expect.objectContaining({ id: sessionId }))
    }
  )

  it('preserves discovered incarnation through routed input and final exit', async () => {
    const spawned = await legacy.spawn({
      worktreeId: 'folder-fixture::/workspace',
      cols: 80,
      rows: 24
    })
    expect(spawned.incarnationId).toEqual(expect.any(String))
    await router.discoverLegacySessions()
    await router.discoverLegacySessions()
    expect(await router.listProcesses()).toEqual([
      expect.objectContaining({ id: spawned.id, incarnationId: spawned.incarnationId })
    ])
    router.write(spawned.id, 'routed input')
    await vi.waitFor(() => expect(child.write).toHaveBeenCalledWith('routed input'))
    const exited = vi.fn()
    router.onExit(exited)
    child.exit()
    await assertRetired()
    expect(exited).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: spawned.id, incarnationId: spawned.incarnationId })
    )
  })

  it('retries after explicit last-route shutdown', async () => {
    await legacy.spawn({ sessionId: 'last', cols: 80, rows: 24 })
    await router.discoverLegacySessions()
    await router.shutdown('last', { immediate: true })
    await assertRetired()
  })

  it('keeps a second client and retries discovery after it disconnects', async () => {
    peer = new DaemonClient({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29
    })
    await peer.ensureConnected()
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    expect(clientFor(legacy).isConnected()).toBe(true)
    peer.disconnect()
    await vi.waitFor(async () => {
      await router.discoverLegacySessions()
      expect(router.getLegacyAdapters()).toEqual([])
    })
    await assertRetired()
  })

  it('keeps in-flight admission and retries when it settles', async () => {
    const admission = (legacyServer as unknown as { admission: { createOrAttachInFlight: number } })
      .admission
    admission.createOrAttachInFlight = 1
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    admission.createOrAttachInFlight = 0
    await router.discoverLegacySessions()
    await assertRetired()
  })

  it('keeps unknown transport and retries after it closes', async () => {
    raw = connect(getDaemonSocketPath(dir, 29))
    await new Promise<void>((resolve) => raw!.once('connect', resolve))
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    raw.destroy()
    await vi.waitFor(async () => {
      await router.discoverLegacySessions()
      expect(router.getLegacyAdapters()).toEqual([])
    })
  })

  it.each(['inventory failure', 'RPC failure', 'unverifiable reply'])(
    'retains routing and subscriptions on %s',
    async (failure) => {
      const client = clientFor(legacy)
      const original = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (type, payload, timeout) => {
        if (type === (failure === 'inventory failure' ? 'listSessions' : 'shutdownIfIdle')) {
          if (failure === 'unverifiable reply') {
            return {} as never
          }
          throw new Error('synthetic failure')
        }
        return original(type, payload, timeout)
      })
      const disconnect = vi.spyOn(legacy, 'disconnectOnly')
      await router.discoverLegacySessions()
      expect(router.getLegacyAdapters()).toEqual([legacy])
      expect(disconnect).not.toHaveBeenCalled()
      expect(client.isConnected()).toBe(true)
      const output = vi.fn()
      router.onData(output)
      vi.mocked(client.request).mockRestore()
      await legacy.spawn({ sessionId: 'still-routed', cols: 80, rows: 24 })
      child.output('retained-output')
      await vi.waitFor(() => expect(output).toHaveBeenCalled())
    }
  )

  it('lets a create between inventory and retirement win in the daemon', async () => {
    const client = clientFor(legacy)
    const original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (type, payload, timeout) => {
      if (type === 'shutdownIfIdle') {
        await original('createOrAttach', { sessionId: 'race-winner', cols: 80, rows: 24 })
      }
      return original(type, payload, timeout)
    })
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    await expect(legacy.listProcesses()).resolves.toEqual([
      expect.objectContaining({ id: 'race-winner' })
    ])
    expect(child.dispose).not.toHaveBeenCalled()
  })

  it('retains missing or different history ownership without requesting retirement', async () => {
    current.dispose()
    current = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir, 36),
      tokenPath: join(dir, 'current.token'),
      protocolVersion: 36,
      historyPath: join(dir, 'another-profile-history')
    })
    router.disposeRouterOnly()
    router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const request = vi.spyOn(clientFor(legacy), 'request')
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    expect(request.mock.calls.some(([type]) => type === 'shutdownIfIdle')).toBe(false)
  })
  it('hands a proved sleeping checkpoint to current before retiring', async () => {
    await legacy.spawn({ sessionId: 'sleeping', cols: 80, rows: 24 })
    child.output('SLEEP-HISTORY-MARKER')
    await router.discoverLegacySessions()
    await router.shutdown('sleeping', { immediate: true, keepHistory: true })
    await assertRetired()
    const restored = await router.spawn({ sessionId: 'sleeping', cols: 80, rows: 24 })
    expect(restored.coldRestore?.scrollback).toContain('SLEEP-HISTORY-MARKER')
  })

  it('retains the history route when handoff cannot prove recovery', async () => {
    await legacy.spawn({ sessionId: 'unreadable-sleep', cols: 80, rows: 24 })
    child.output('PRESERVE-SLEEP')
    await router.discoverLegacySessions()
    const handoff = vi.spyOn(legacy, 'canHandoffHistoryTo').mockResolvedValue(false)
    const retirement = vi.spyOn(legacy, 'retireIfIdle')
    await router.shutdown('unreadable-sleep', { immediate: true, keepHistory: true })
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    expect(retirement).not.toHaveBeenCalled()
    handoff.mockRestore()
    const restored = await router.spawn({ sessionId: 'unreadable-sleep', cols: 80, rows: 24 })
    expect(restored.coldRestore?.scrollback).toContain('PRESERVE-SLEEP')
    expect(current.hasPty('unreadable-sleep')).toBe(false)
  })

  it('preserves and restores inactive-profile disk checkpoints after empty adoption', async () => {
    const sessionId = 'inactive-profile-sleep'
    await legacy.spawn({ sessionId, cols: 80, rows: 24 })
    child.output('INACTIVE-PROFILE-HISTORY')
    await legacy.shutdown(sessionId, { immediate: true, keepHistory: true })
    peer = new DaemonClient({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29
    })
    await peer.ensureConnected()
    router.disposeRouterOnly()
    await legacy.disconnectOnly()
    legacy = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29,
      historyPath: join(dir, 'history')
    })
    await legacy.establishLifecycleLease()
    peer.disconnect()
    const historyDir = join(dir, 'history', getHistorySessionDirName(sessionId))
    const before = new Map(
      readdirSync(historyDir).map((name) => [name, readFileSync(join(historyDir, name))])
    )
    router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await vi.waitFor(async () => {
      await router.discoverLegacySessions()
      expect(router.getLegacyAdapters()).toEqual([])
    })
    expect(readdirSync(historyDir).sort()).toEqual([...before.keys()].sort())
    for (const [name, bytes] of before) {
      expect(readFileSync(join(historyDir, name))).toEqual(bytes)
    }
    const restored = await router.spawn({ sessionId, cols: 80, rows: 24 })
    expect(restored.coldRestore?.scrollback).toContain('INACTIVE-PROFILE-HISTORY')
  })

  it('refuses unreadable known history instead of acknowledging it', async () => {
    const sessionId = 'corrupt-checkpoint'
    await legacy.spawn({ sessionId, cols: 80, rows: 24 })
    child.output('CHECKPOINT')
    await legacy.shutdown(sessionId, { immediate: true, keepHistory: true })
    const historyDir = join(dir, 'history', getHistorySessionDirName(sessionId))
    writeFileSync(join(historyDir, 'checkpoint.json'), '{')
    await expect(legacy.canHandoffHistoryTo(current, sessionId)).resolves.toBe(false)
    await expect(legacy.retireIfIdle(current)).resolves.toBe(false)
  })

  it('does not change pre-v24 discovery', async () => {
    router.disposeRouterOnly()
    legacy.dispose()
    await legacyServer.shutdown()
    legacyServer = new DaemonServer({
      socketPath: getDaemonSocketPath(dir, 23),
      tokenPath: join(dir, 'old.token'),
      protocolVersion: 23,
      spawnSubprocess: subprocess,
      log: { log: () => {}, close: () => {} }
    })
    await legacyServer.start()
    legacy = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir, 23),
      tokenPath: join(dir, 'old.token'),
      protocolVersion: 23,
      historyPath: join(dir, 'history')
    })
    router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const request = vi.spyOn(clientFor(legacy), 'request')
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toEqual([legacy])
    expect(clientFor(legacy).isConnected()).toBe(true)
    expect(request.mock.calls.some(([type]) => type === 'shutdownIfIdle')).toBe(false)
  })
  it('retires after another session exits during an in-flight explicit release', async () => {
    await legacy.spawn({ sessionId: 'closing', cols: 80, rows: 24 })
    await legacy.spawn({ sessionId: 'exiting', cols: 80, rows: 24 })
    await router.discoverLegacySessions()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let killing = false
    const client = clientFor(legacy)
    const request = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (type, payload, timeout) => {
      if (type === 'kill') {
        killing = true
        await gate
      }
      return request(type, payload, timeout)
    })
    const closing = router.shutdown('closing', { immediate: true })
    await vi.waitFor(() => expect(killing).toBe(true))
    children.get('exiting')!.exit()
    await vi.waitFor(async () => expect(await legacy.listProcesses()).toHaveLength(1))
    release?.()
    await closing
    await assertRetired()
  })
  it('does not reuse confirmed retirement for a replacement daemon incarnation', async () => {
    await router.discoverLegacySessions()
    await assertRetired()
    legacyServer = new DaemonServer({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29,
      spawnSubprocess: () => child,
      log: { log: () => {}, close: () => {} }
    })
    await legacyServer.start()
    await legacy.establishLifecycleLease()
    await clientFor(legacy).request('createOrAttach', {
      sessionId: 'replacement-live',
      cols: 80,
      rows: 24
    })
    await expect(legacy.retireIfIdle(current)).resolves.toBe(false)
    await expect(legacy.listProcesses()).resolves.toEqual([
      expect.objectContaining({ id: 'replacement-live' })
    ])
  })

  it('shares an in-flight retirement across a router-only restart', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requested = false
    const client = clientFor(legacy)
    const request = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (type, payload, timeout) => {
      if (type === 'shutdownIfIdle') {
        requested = true
        await gate
      }
      return request(type, payload, timeout)
    })
    const firstDiscovery = router.discoverLegacySessions()
    await vi.waitFor(() => expect(requested).toBe(true))
    router.disposeRouterOnly()
    router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const secondDiscovery = router.discoverLegacySessions()
    release?.()
    await Promise.all([firstDiscovery, secondDiscovery])
    await assertRetired()
  })
  it.each(['handoff', 'refusal', 'failure'])(
    'serializes concurrent wake through the sleep custody commit: %s',
    async (outcome) => {
      const id = 'handoff-race'
      await legacy.spawn({ sessionId: id, cols: 80, rows: 24 })
      child.output('RACE-RECOVERY-MARKER')
      await router.discoverLegacySessions()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let checking = false
      const original = legacy.canHandoffHistoryTo.bind(legacy)
      vi.spyOn(legacy, 'canHandoffHistoryTo').mockImplementation(async (...args) => {
        const readable = await original(...args)
        checking = true
        await gate
        if (outcome === 'failure') {
          throw new Error('handoff interrupted')
        }
        return outcome === 'handoff' && readable
      })
      const sleeping = router
        .shutdown(id, { immediate: true, keepHistory: true })
        .catch((error: Error) => error)
      await vi.waitFor(() => expect(checking).toBe(true))
      let woke = false
      const waking = router.spawn({ sessionId: id, cols: 80, rows: 24 }).then((result) => {
        woke = true
        return result
      })
      try {
        await router.spawn({ sessionId: 'unrelated', cols: 80, rows: 24 })
        expect(woke).toBe(false)
      } finally {
        release()
        const result = await sleeping
        if (outcome === 'failure') {
          expect(result).toEqual(new Error('handoff interrupted'))
        } else {
          expect(result).toBeUndefined()
        }
      }
      const awakened = await waking
      expect(awakened.coldRestore?.scrollback).toContain('RACE-RECOVERY-MARKER')
      const owner = outcome === 'handoff' ? current : legacy
      const other = outcome === 'handoff' ? legacy : current
      expect(owner.hasPty(id)).toBe(true)
      expect(other.hasPty(id)).toBe(false)
      const ownerWrite = vi.spyOn(owner, 'write')
      const otherWrite = vi.spyOn(other, 'write')
      router.write(id, 'wake-input')
      expect(otherWrite).not.toHaveBeenCalled()
      expect(ownerWrite).toHaveBeenCalledWith(id, 'wake-input')
    }
  )
  it('independent: unrelated probe cannot overwrite a committed wake route', async () => {
    const id = 'stale-inventory-wake'
    await legacy.spawn({ sessionId: id, cols: 80, rows: 24 })
    child.output('INVENTORY-RECOVERY-MARKER')
    await router.discoverLegacySessions()
    peer = new DaemonClient({
      socketPath: getDaemonSocketPath(dir, 29),
      tokenPath: join(dir, 'legacy.token'),
      protocolVersion: 29
    })
    await peer.ensureConnected()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let captured = false
    const realList = legacy.listProcesses.bind(legacy)
    vi.spyOn(legacy, 'listProcesses').mockImplementationOnce(async (...args) => {
      const result = await realList(...args)
      expect(result.some((row) => row.id === id)).toBe(true)
      captured = true
      await gate
      return result
    })
    const probe = router.probePtyLiveness('different-missing-id')
    await vi.waitFor(() => expect(captured).toBe(true))
    try {
      await router.shutdown(id, { immediate: true, keepHistory: true })
      const awakened = await router.spawn({ sessionId: id, cols: 80, rows: 24 })
      expect(awakened.coldRestore?.scrollback).toContain('INVENTORY-RECOVERY-MARKER')
      expect(current.hasPty(id)).toBe(true)
      expect(legacy.hasPty(id)).toBe(false)
    } finally {
      release()
      await probe
    }
    const oldWrite = vi.spyOn(legacy, 'write')
    const newWrite = vi.spyOn(current, 'write')
    router.write(id, 'wake-input')
    expect(oldWrite).not.toHaveBeenCalled()
    expect(newWrite).toHaveBeenCalledWith(id, 'wake-input')
  })
})
