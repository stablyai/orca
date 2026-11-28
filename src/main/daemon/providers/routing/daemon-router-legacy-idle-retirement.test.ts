import '../../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonServer } from '../../server/daemon-server'
import { DaemonClient } from '../../transport/client/daemon-client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../launch/daemon-spawner'
import { HostTerminalPolicy } from '../../admission/host-terminal-policy'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonRouterLegacyIdleRetirement } from './daemon-router-legacy-idle-retirement'

const LEGACY = PROTOCOL_VERSION - 1

type Generation = {
  server: DaemonServer
  socketPath: string
  tokenPath: string
  protocolVersion: number
  retired: boolean
  endSession: (sessionId: string) => void
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startGeneration(dir: string, protocolVersion: number): Promise<Generation> {
  const exits = new Map<string, () => void>()
  const socketPath = getDaemonSocketPath(dir, protocolVersion)
  const tokenPath = getDaemonTokenPath(dir, protocolVersion)
  const generation: Generation = {
    socketPath,
    tokenPath,
    protocolVersion,
    retired: false,
    endSession: (sessionId) => exits.get(sessionId)?.(),
    server: new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion,
      hostTerminalLedgerDir: join(dir, `terminals-${protocolVersion}`),
      terminalLimitPolicy: new HostTerminalPolicy(null, {}),
      onIdleShutdown: () => {
        generation.retired = true
      },
      spawnSubprocess: ({ sessionId }): SubprocessHandle => {
        let notifyExit: ((code: number) => void) | null = null
        const exit = (): void => notifyExit?.(0)
        exits.set(sessionId, exit)
        return {
          pid: 44447,
          getForegroundProcess: () => null,
          write() {},
          resize() {},
          kill: exit,
          terminateOwnedTree: () => 'unavailable' as const,
          forceKill: exit,
          signal() {},
          onData() {},
          onExit(callback) {
            notifyExit = callback
          },
          dispose() {}
        }
      }
    })
  }
  await generation.server.start()
  cleanups.push(() => (generation.retired ? undefined : generation.server.shutdown()))
  return generation
}

function adapterFor(dir: string, generation: Generation): DaemonPtyAdapter {
  return new DaemonPtyAdapter({
    socketPath: generation.socketPath,
    tokenPath: generation.tokenPath,
    protocolVersion: generation.protocolVersion,
    historyPath: join(dir, 'history'),
    // In process, a retired daemon's "process" is gone once its idle shutdown finished.
    preservedDaemonExited: () => generation.retired
  })
}

/** One app launch: a router over the current generation and the older one. */
function launchApp(dir: string, current: Generation, legacy: Generation) {
  const currentAdapter = adapterFor(dir, current)
  const legacyAdapter = adapterFor(dir, legacy)
  const router = new DaemonPtyRouter({
    current: currentAdapter,
    legacy: [legacyAdapter],
    legacyIdleRetirementTiming: { exitSettleMs: 0, recheckMs: 60_000, fenceMaxMs: 5_000 }
  })
  cleanups.push(() => router.disconnectOnly())
  return { router, currentAdapter, legacyAdapter }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-idle-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const current = await startGeneration(dir, PROTOCOL_VERSION)
  const legacy = await startGeneration(dir, LEGACY)
  return { dir, current, legacy }
}

/** A terminal the previous app version opened on the older generation, left running at quit. */
async function seedOlderTerminal(legacy: Generation, sessionId: string): Promise<void> {
  const client = new DaemonClient({
    socketPath: legacy.socketPath,
    tokenPath: legacy.tokenPath,
    protocolVersion: legacy.protocolVersion
  })
  await client.ensureConnected()
  await client.request('createOrAttach', { sessionId, cols: 80, rows: 24 })
  client.disconnect()
}

const size = { cols: 80, rows: 24 }

function gate() {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  return { released, reached, reach, release }
}

/** Holds the next spawn the older generation is given until the test lets it through. */
function holdNextSpawn(adapter: DaemonPtyAdapter) {
  const held = gate()
  const spawn = adapter.spawn.bind(adapter)
  vi.spyOn(adapter, 'spawn').mockImplementationOnce(async (opts) => {
    held.reach()
    await held.released
    return spawn(opts)
  })
  return held
}

/** Holds the answer to the next retirement decision; the decision itself is asked at once. */
function holdNextDecision(adapter: DaemonPtyAdapter) {
  const held = gate()
  const decide = adapter.requestIdleRetirement.bind(adapter)
  vi.spyOn(adapter, 'requestIdleRetirement').mockImplementationOnce(async () => {
    const decision = decide()
    held.reach()
    await held.released
    return decision
  })
  return held
}

describe.skipIf(process.platform === 'win32')(
  'an older daemon generation that retires itself',
  () => {
    it('serves reattach across an app restart, retires itself after its last terminal ends, and the current one stays', async () => {
      const { dir, current, legacy } = await setup()
      await seedOlderTerminal(legacy, 'old-1')

      // First launch reattaches, then quits without ending either terminal.
      const first = launchApp(dir, current, legacy)
      await first.router.discoverLegacySessions()
      expect((await first.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })).isReattach).toBe(
        true
      )
      // Quit retires an empty current daemon by design; one terminal keeps it for the next launch.
      const kept = await first.router.spawn({ ...size, cwd: dir })
      await first.router.disconnectOnly()

      // Second launch: the older generation still owns the terminal, so it keeps serving it.
      const app = launchApp(dir, current, legacy)
      await app.router.discoverLegacySessions()
      expect((await app.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })).isReattach).toBe(
        true
      )
      await vi.waitFor(() => expect(app.legacyAdapter.isHeldForRetirement()).toBe(true))
      expect(app.router.getLegacyAdapters()).toEqual([app.legacyAdapter])
      const currentAsked = vi.spyOn(app.currentAdapter, 'askRetireWhenIdle')

      legacy.endSession('old-1')
      await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })
      await vi.waitFor(() => expect(app.router.getLegacyAdapters()).toEqual([]), { timeout: 5_000 })

      // The current generation keeps serving, empty or not.
      current.endSession(kept.id)
      const fresh = await app.router.spawn({ ...size, cwd: dir })
      current.endSession(fresh.id)
      await vi.waitFor(() => expect(current.server.host.listSessions()).toEqual([]))
      const next = await app.router.spawn({ ...size, cwd: dir })
      expect(current.server.host.listSessions().map((s) => s.sessionId)).toEqual([next.id])
      expect(currentAsked).not.toHaveBeenCalled()
      expect(current.retired).toBe(false)
    })

    it('routes a reattach that reaches it after it decided to the current generation', async () => {
      const { dir, current, legacy } = await setup()
      await seedOlderTerminal(legacy, 'old-1')
      const app = launchApp(dir, current, legacy)
      await app.router.discoverLegacySessions()
      await vi.waitFor(() => expect(app.legacyAdapter.isHeldForRetirement()).toBe(true))

      // Routed to the older generation while it still owns the terminal, then held there.
      const held = holdNextSpawn(app.legacyAdapter)
      const reattach = app.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })
      await held.reached
      legacy.endSession('old-1')
      await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })

      held.release()
      const restored = await reattach
      expect(restored.id).toBe('old-1')
      expect(current.server.host.listSessions().map((s) => s.sessionId)).toEqual(['old-1'])
      expect(app.router.getLegacyAdapters()).toEqual([])
    })

    it('is never asked of, and refused by, the current generation', async () => {
      const { current } = await setup()
      const client = new DaemonClient({
        socketPath: current.socketPath,
        tokenPath: current.tokenPath
      })
      cleanups.push(() => client.disconnect())
      await client.ensureConnected()
      for (const currentProtocolVersion of [PROTOCOL_VERSION, LEGACY, undefined]) {
        await expect(client.request('retireWhenIdle', { currentProtocolVersion })).rejects.toThrow(
          /refused/
        )
      }
      // Empty, with this client gone: only an ordinary last-client retirement could stop it now.
      await client.request('createOrAttach', { sessionId: 'kept', cols: 80, rows: 24 })
      expect(current.retired).toBe(false)
    })
  }
)

// Transitional: generations from before `retireWhenIdle` (v63 and older) are asked by the app.
describe.skipIf(process.platform === 'win32')(
  'an older generation from before retireWhenIdle',
  () => {
    function launchPreRpcApp(dir: string, current: Generation, legacy: Generation) {
      const app = launchApp(dir, current, legacy)
      vi.spyOn(app.legacyAdapter, 'askRetireWhenIdle').mockResolvedValue('unsupported')
      return app
    }

    it('holds reattaches while it decides, routes them to current after it retires, and never delays a new terminal', async () => {
      const { dir, current, legacy } = await setup()
      const app = launchPreRpcApp(dir, current, legacy)
      const decision = holdNextDecision(app.legacyAdapter)
      await app.router.discoverLegacySessions()
      await decision.reached

      let reattachSettled = false
      const reattach = app.router
        .spawn({ ...size, sessionId: 'restored', cwd: dir })
        .finally(() => (reattachSettled = true))
      const fresh = await app.router.spawn({ ...size, cwd: dir })
      expect(current.server.host.listSessions().map((s) => s.sessionId)).toContain(fresh.id)
      expect(reattachSettled).toBe(false)

      decision.release()
      const restored = await reattach
      await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })
      expect(restored.id).toBe('restored')
      expect(current.server.host.listSessions().map((s) => s.sessionId)).toContain('restored')
      expect(legacy.server.host.listSessions()).toEqual([])
      await vi.waitFor(() => expect(app.router.getLegacyAdapters()).toEqual([]))
    })

    it('asks no decision while a reattach to it is in flight, even once it reads empty', async () => {
      const { dir, current, legacy } = await setup()
      await seedOlderTerminal(legacy, 'old-1')
      await seedOlderTerminal(legacy, 'old-2')
      const app = launchPreRpcApp(dir, current, legacy)
      await app.router.discoverLegacySessions()
      // Attached, so its exit reaches the app and starts an emptiness check.
      await app.router.spawn({ ...size, sessionId: 'old-2', cwd: dir })
      const decision = vi.spyOn(app.legacyAdapter, 'requestIdleRetirement')
      const inventory = vi.spyOn(app.legacyAdapter, 'listSessionsAndRelays')
      const held = holdNextSpawn(app.legacyAdapter)

      const reattach = app.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })
      await held.reached
      inventory.mockClear()
      legacy.endSession('old-1')
      legacy.endSession('old-2')
      await vi.waitFor(() => expect(legacy.server.host.listSessions()).toEqual([]))
      // The exit's check finds the reattach in flight and defers before it reads anything.
      await vi.waitFor(() => expect(app.legacyAdapter.getActiveSessionIds()).toEqual([]))
      expect(inventory).not.toHaveBeenCalled()
      expect(decision).not.toHaveBeenCalled()

      // The reattach lands after its terminal ended and starts it again there: work the old generation keeps.
      held.release()
      const result = await reattach
      // Its terminal is watched again, so the generation stays.
      expect(app.legacyAdapter.hasWatchedSessions()).toBe(true)
      expect(decision).not.toHaveBeenCalled()
      expect(legacy.retired).toBe(false)
      expect(legacy.server.host.listSessions().map((s) => s.sessionId)).toEqual([result.id])

      legacy.endSession(result.id)
      await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })
      await vi.waitFor(() => expect(app.router.getLegacyAdapters()).toEqual([]))
    })
  }
)

describe('the transitional recheck timer', () => {
  type Stub = Partial<Record<keyof DaemonPtyAdapter, unknown>> & { protocolVersion: number }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the class reads only the members each stub defines.
  const asAdapter = (stub: Stub) => stub as unknown as DaemonPtyAdapter

  function stubs() {
    const inventory: { sessions: { sessionId: string }[]; liveRelays: number } = {
      sessions: [],
      liveRelays: 1
    }
    const state = { watched: false, admissionClosed: false, retired: false }
    const base = {
      hasRetiredForIdle: () => false,
      wasAskedToRetireWhenIdle: () => false,
      isHeldForRetirement: () => true,
      onConnectionLost: () => () => {}
    }
    const current = asAdapter({ protocolVersion: PROTOCOL_VERSION })
    const held = asAdapter({
      ...base,
      protocolVersion: LEGACY,
      askRetireWhenIdle: vi.fn(async () => 'held')
    })
    const preRpc = asAdapter({
      ...base,
      protocolVersion: LEGACY - 1,
      askRetireWhenIdle: vi.fn(async () => 'unsupported'),
      listSessionsAndRelays: vi.fn(async () => inventory),
      hasRetiredForIdle: () => state.retired,
      getActiveSessionIds: () => [],
      hasWatchedSessions: () => state.watched,
      isIdleRetirementAdmissionClosed: () => state.admissionClosed,
      requestIdleRetirement: vi.fn(async () => {
        state.retired = true
        return { state: 'retiring' }
      })
    })
    return { current, held, preRpc, inventory, state }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never exists with only generations that retire themselves', async () => {
    vi.useFakeTimers()
    const { current, held } = stubs()
    const legacy = [held]
    const retirement = new DaemonRouterLegacyIdleRetirement({
      current: () => current,
      legacy: () => legacy,
      drop: () => {}
    })
    retirement.noteAll()
    retirement.noteActivity(held)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off while an older generation holds work it sends no exit for, and stops for good once it retires', async () => {
    vi.useFakeTimers()
    const { current, held, preRpc, inventory } = stubs()
    const legacy = [held, preRpc]
    const retirement = new DaemonRouterLegacyIdleRetirement({
      current: () => current,
      legacy: () => legacy,
      drop: (adapter) => legacy.splice(legacy.indexOf(adapter), 1)
    })
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(1_000)
    const listed = vi.mocked(preRpc.listSessionsAndRelays)
    expect(listed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    // 1, 2 and 4 minutes later: three more reads in seven minutes, then none for eight.
    await vi.advanceTimersByTimeAsync(7 * 60_000)
    expect(listed).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(7 * 60_000)
    expect(listed).toHaveBeenCalledTimes(4)

    inventory.liveRelays = 0
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(legacy).toEqual([held])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(listed).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up after a bounded number of rechecks when the work never ends', async () => {
    vi.useFakeTimers()
    const { current, preRpc } = stubs()
    const legacy = [preRpc]
    const retirement = new DaemonRouterLegacyIdleRetirement({
      current: () => current,
      legacy: () => legacy,
      drop: () => {}
    })
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    // The first read and six rechecks (1 to 30 minutes apart), then nothing until the next exit.
    expect(vi.mocked(preRpc.listSessionsAndRelays)).toHaveBeenCalledTimes(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  function track(preRpc: DaemonPtyAdapter, current: DaemonPtyAdapter) {
    const legacy = [preRpc]
    const retirement = new DaemonRouterLegacyIdleRetirement({
      current: () => current,
      legacy: () => legacy,
      drop: (adapter) => legacy.splice(legacy.indexOf(adapter), 1)
    })
    return { legacy, retirement }
  }

  it('reads nothing while a terminal it still watches is alive', async () => {
    vi.useFakeTimers()
    const { current, preRpc, state } = stubs()
    state.watched = true
    const { retirement } = track(preRpc, current)
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(1_000)
    // Another watched terminal's exit, with one still alive.
    retirement.noteActivity(preRpc)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(vi.mocked(preRpc.listSessionsAndRelays)).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a generation that retired with a watched terminal until that exit is delivered', async () => {
    vi.useFakeTimers()
    const { current, preRpc, inventory, state } = stubs()
    // Fenced by an unanswered decision, so it is asked even while a terminal is watched.
    Object.assign(state, { watched: true, admissionClosed: true })
    inventory.liveRelays = 0
    const { legacy, retirement } = track(preRpc, current)
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.retired).toBe(true)
    retirement.noteActivity(preRpc)
    expect(legacy).toEqual([preRpc])
    state.watched = false
    retirement.noteActivity(preRpc)
    expect(legacy).toEqual([])
  })

  it('forgets a retired generation whose last exit never arrives', async () => {
    vi.useFakeTimers()
    const { current, preRpc, inventory, state } = stubs()
    Object.assign(state, { watched: true, admissionClosed: true })
    inventory.liveRelays = 0
    const { legacy, retirement } = track(preRpc, current)
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(legacy).toEqual([preRpc])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(legacy).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits out a slow decision without forgetting a generation whose watched exit is still owed', async () => {
    vi.useFakeTimers()
    const { current, preRpc, inventory, state } = stubs()
    Object.assign(state, { watched: true, admissionClosed: true })
    inventory.liveRelays = 0
    let answer!: () => void
    vi.mocked(preRpc.requestIdleRetirement).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => {
            state.retired = true
            resolve({ state: 'retiring' })
          }
        })
    )
    const { legacy, retirement } = track(preRpc, current)
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(1_000)
    // Another exit while the decision is pending asks for a second check after it.
    retirement.noteActivity(preRpc)
    await vi.advanceTimersByTimeAsync(1_000)
    answer()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(legacy).toEqual([preRpc])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(legacy).toEqual([])
  })

  it('stops rechecking a fenced generation after the cap, and asks it again when it refuses a spawn', async () => {
    vi.useFakeTimers()
    const { current, preRpc, state } = stubs()
    state.admissionClosed = true
    const decide = vi.mocked(preRpc.requestIdleRetirement)
    decide.mockImplementation(async () => ({ state: 'unverifiable' }))
    const { legacy, retirement } = track(preRpc, current)
    retirement.noteAll()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    // The first decision, its follow-up and six rechecks; then no timer until something asks.
    expect(decide).toHaveBeenCalledTimes(8)
    expect(vi.getTimerCount()).toBe(0)

    decide.mockImplementation(async () => {
      state.admissionClosed = false
      return { state: 'busy', liveSessions: 1 }
    })
    const refused = new Error('Terminal daemon is decommissioning')
    await expect(retirement.settleHeldRetirements(refused, 1, preRpc)).resolves.toBe(true)
    expect(decide).toHaveBeenCalledTimes(9)
    expect(legacy).toEqual([preRpc])
  })
})
