import './mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeNet from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnForStablePane, type StablePaneOwner } from '../ipc/pty/pane/stable-owner'
import { isPtyAlreadyGoneError } from '../ipc/pty/provider/liveness'
import type { IPtyProvider, PtySpawnResult } from '../providers/types'
import type { DaemonFileLog } from './daemon-file-log'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'

// Endpoints whose connect the kernel completes but the app never observes before its own timer:
// the measured startup trigger is the app's main thread stalling ~1 s across the check.
const stalledEndpoints = vi.hoisted(() => ({ always: new Set<string>(), once: new Set<string>() }))

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeNet>()
  const { EventEmitter } = await import('node:events')
  // Daemon clients connect by socket path only (a string or `{ path }`).
  function connect(target: string | NodeNet.IpcNetConnectOpts): unknown {
    const path = typeof target === 'string' ? target : target.path
    if (stalledEndpoints.always.has(path) || stalledEndpoints.once.delete(path)) {
      return Object.assign(new EventEmitter(), { destroy: () => {} })
    }
    return typeof target === 'string' ? actual.connect(target) : actual.connect(target)
  }
  return { ...actual, connect, default: { ...actual, connect } }
})

type FixtureSubprocess = SubprocessHandle & { killed: boolean }

function createFixtureSubprocess(pid: number): FixtureSubprocess {
  let onExit: ((code: number) => void) | undefined
  const subprocess: FixtureSubprocess = {
    pid,
    killed: false,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => {
      subprocess.killed = true
      onExit?.(0)
    }),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => {
      subprocess.killed = true
      onExit?.(137)
    }),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
  return subprocess
}

const silentLog: DaemonFileLog = { log: () => {}, close: () => {} }
const LEGACY = 35
const SESSION_ID = 'wt-1@@0a1b2c3d'

describe('startup census of previous daemon versions the app could not reach', () => {
  const servers: DaemonServer[] = []
  const adapters: DaemonPtyAdapter[] = []
  const routers: DaemonPtyRouter[] = []
  const directories: string[] = []
  const spawnsByVersion = new Map<number, FixtureSubprocess[]>()

  afterEach(async () => {
    stalledEndpoints.always.clear()
    stalledEndpoints.once.clear()
    for (const router of routers.splice(0)) {
      router.dispose()
    }
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await Promise.all(servers.splice(0).map((server) => server.shutdown()))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
    spawnsByVersion.clear()
  })

  function spawnsOf(protocolVersion: number): FixtureSubprocess[] {
    const spawns = spawnsByVersion.get(protocolVersion) ?? []
    spawnsByVersion.set(protocolVersion, spawns)
    return spawns
  }

  async function startDaemon(runtimeDir: string, protocolVersion: number): Promise<void> {
    const server = new DaemonServer({
      socketPath: getDaemonSocketPath(runtimeDir, protocolVersion),
      tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
      protocolVersion,
      log: silentLog,
      spawnSubprocess: () => {
        const subprocess = createFixtureSubprocess(
          protocolVersion * 1_000 + spawnsOf(protocolVersion).length
        )
        spawnsOf(protocolVersion).push(subprocess)
        return subprocess
      }
    })
    servers.push(server)
    await server.start()
  }

  function adapterFor(runtimeDir: string, protocolVersion: number): DaemonPtyAdapter {
    const adapter = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(runtimeDir, protocolVersion),
      tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
      protocolVersion
    })
    adapters.push(adapter)
    return adapter
  }

  /** A session a previous app run left behind, then quit. */
  async function seedSession(
    runtimeDir: string,
    protocolVersion: number,
    sessionId = SESSION_ID
  ): Promise<PtySpawnResult> {
    const previousApp = adapterFor(runtimeDir, protocolVersion)
    const session = await previousApp.spawn({ sessionId, cols: 80, rows: 24 })
    previousApp.dispose()
    return session
  }

  async function setUp(versions: number[]): Promise<string> {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-census-'))
    directories.push(runtimeDir)
    for (const protocolVersion of [...versions, PROTOCOL_VERSION]) {
      await startDaemon(runtimeDir, protocolVersion)
    }
    return runtimeDir
  }

  /** Mirrors daemon-provider-init: census, then a router only when a previous version was kept. */
  async function startApp(runtimeDir: string): Promise<IPtyProvider> {
    const legacy = await createLegacyDaemonAdapters(runtimeDir, join(runtimeDir, 'history'))
    adapters.push(...legacy)
    const current = adapterFor(runtimeDir, PROTOCOL_VERSION)
    if (legacy.length === 0) {
      return current
    }
    const router = new DaemonPtyRouter({ current, legacy })
    routers.push(router)
    await router.discoverLegacySessions()
    return router
  }

  /** A restored agent pane reattaching to its saved session, as the renderer asks after launch. */
  function restorePane(
    provider: IPtyProvider,
    saved: { id: string; incarnationId?: string }
  ): ReturnType<typeof spawnForStablePane> {
    const owner: StablePaneOwner = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ptyId: saved.id,
      hasPersistedBinding: true,
      ...(saved.incarnationId
        ? { incarnationId: saved.incarnationId, persistedIncarnationId: saved.incarnationId }
        : {})
    }
    return spawnForStablePane({
      runtime: undefined,
      provider,
      owner,
      spawnOptions: { sessionId: saved.id, cols: 80, rows: 24, command: 'claude --resume c-1' }
    })
  }

  it('leaves the pane unverified when the only previous version missed its check', async () => {
    const runtimeDir = await setUp([LEGACY])
    const saved = await seedSession(runtimeDir, LEGACY)
    stalledEndpoints.always.add(getDaemonSocketPath(runtimeDir, LEGACY))

    const provider = await startApp(runtimeDir)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(restorePane(provider, saved)).rejects.toThrow('terminal_pane_owner_unverified')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`pane session ${saved.id} unverified`)
    )
    warn.mockRestore()
    // No second copy of the agent in the current daemon, and the original is untouched.
    expect(spawnsOf(PROTOCOL_VERSION)).toHaveLength(0)
    expect(spawnsOf(LEGACY)[0]?.killed).toBe(false)
  })

  it('leaves the pane unverified when another previous version answered', async () => {
    const runtimeDir = await setUp([LEGACY - 1, LEGACY])
    const saved = await seedSession(runtimeDir, LEGACY)
    stalledEndpoints.always.add(getDaemonSocketPath(runtimeDir, LEGACY))

    const provider = await startApp(runtimeDir)

    await expect(restorePane(provider, saved)).rejects.toThrow('terminal_pane_owner_unverified')
    expect(spawnsOf(PROTOCOL_VERSION)).toHaveLength(0)
  })

  it('reattaches silently when the version answers once the startup stall is over', async () => {
    const runtimeDir = await setUp([LEGACY])
    const saved = await seedSession(runtimeDir, LEGACY)
    stalledEndpoints.once.add(getDaemonSocketPath(runtimeDir, LEGACY))

    const provider = await startApp(runtimeDir)
    const restored = await restorePane(provider, saved)

    expect(restored.owner).not.toBeNull()
    expect(restored.result).toMatchObject({
      id: saved.id,
      incarnationId: saved.incarnationId,
      isReattach: true
    })
    expect(spawnsOf(PROTOCOL_VERSION)).toHaveLength(0)
  })

  it('reattaches a pane whose session lives in a reachable version by its saved identity', async () => {
    const runtimeDir = await setUp([LEGACY])
    const saved = await seedSession(runtimeDir, PROTOCOL_VERSION)
    stalledEndpoints.always.add(getDaemonSocketPath(runtimeDir, LEGACY))

    const provider = await startApp(runtimeDir)
    const restored = await restorePane(provider, saved)

    expect(restored.result).toMatchObject({ id: saved.id, incarnationId: saved.incarnationId })
    expect(spawnsOf(PROTOCOL_VERSION)).toHaveLength(1)
  })

  it('tells apart two live sessions sharing an id when one version is unreachable', async () => {
    const runtimeDir = await setUp([LEGACY])
    // The aftermath of the old bug: the original lives on in v35, a fresh copy took the id here.
    const orphan = await seedSession(runtimeDir, LEGACY)
    const copy = await seedSession(runtimeDir, PROTOCOL_VERSION)
    stalledEndpoints.always.add(getDaemonSocketPath(runtimeDir, LEGACY))

    const provider = await startApp(runtimeDir)

    // A pane saved against the orphan is neither started over nor handed the other copy.
    await expect(restorePane(provider, orphan)).rejects.toThrow('terminal_pane_owner_unverified')
    await expect(restorePane(provider, copy)).resolves.toMatchObject({
      result: { id: SESSION_ID, incarnationId: copy.incarnationId, isReattach: true }
    })
    expect(spawnsOf(PROTOCOL_VERSION)).toHaveLength(1)
  })

  it('does not read closing a stuck pane as its session already being gone', async () => {
    const runtimeDir = await setUp([LEGACY - 1, LEGACY])
    const saved = await seedSession(runtimeDir, LEGACY)
    stalledEndpoints.always.add(getDaemonSocketPath(runtimeDir, LEGACY))
    const provider = await startApp(runtimeDir)
    await expect(restorePane(provider, saved)).rejects.toThrow('terminal_pane_owner_unverified')

    const close = provider.shutdown(saved.id, { immediate: true })

    await expect(close).rejects.toSatisfy((error) => !isPtyAlreadyGoneError(error))
    expect(spawnsOf(LEGACY)[0]?.killed).toBe(false)
    // Input for it is refused rather than handed to the current daemon.
    expect(provider.write(saved.id, 'y\r')).toBe(false)
    await expect(provider.writeWithSettlement?.(saved.id, 'y\r')).resolves.toMatchObject({
      outcome: 'refused'
    })
  })

  it('closes a tab no one reattached this run by its saved identity while a version is unreachable', async () => {
    const runtimeDir = await setUp([LEGACY])
    const saved = await seedSession(runtimeDir, PROTOCOL_VERSION)
    stalledEndpoints.always.add(getDaemonSocketPath(runtimeDir, LEGACY))
    const provider = await startApp(runtimeDir)

    // Without the saved identity the silent version could hold the same id, so nothing is killed.
    await expect(provider.shutdown(saved.id, { immediate: true })).rejects.toSatisfy(
      (error) => !isPtyAlreadyGoneError(error)
    )
    expect(spawnsOf(PROTOCOL_VERSION)[0]?.killed).toBe(false)

    await provider.shutdown(saved.id, {
      immediate: true,
      expectedIncarnationId: saved.incarnationId
    })
    expect(spawnsOf(PROTOCOL_VERSION)[0]?.killed).toBe(true)
  })

  it('still reports a session absent from every version that answered', async () => {
    const runtimeDir = await setUp([LEGACY])
    const saved = await seedSession(runtimeDir, LEGACY)
    const provider = await startApp(runtimeDir)

    await expect(provider.shutdown('wt-1@@ffffffff', { immediate: true })).rejects.toSatisfy(
      (error) => isPtyAlreadyGoneError(error)
    )
    await provider.shutdown(saved.id, { immediate: true })
    expect(spawnsOf(LEGACY)[0]?.killed).toBe(true)
  })
})
