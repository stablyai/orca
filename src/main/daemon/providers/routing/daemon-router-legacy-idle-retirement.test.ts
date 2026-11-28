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
  for (const cleanup of cleanups.splice(0).reverse()) {
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
    historyPath: join(dir, 'history')
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

describe.skipIf(process.platform === 'win32')('retiring an empty older daemon generation', () => {
  it('serves reattach across an app restart, retires after its last terminal ends, and never retires the current one', async () => {
    const { dir, current, legacy } = await setup()
    await seedOlderTerminal(legacy, 'old-1')

    // First launch reattaches, then quits without ending either terminal.
    const first = launchApp(dir, current, legacy)
    await first.router.discoverLegacySessions()
    const firstAttach = await first.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })
    expect(firstAttach.isReattach).toBe(true)
    // Quit retires an empty current daemon by design; one terminal keeps it for the next launch.
    const kept = await first.router.spawn({ ...size, cwd: dir })
    await first.router.disconnectOnly()

    // Second launch: the older generation still owns the terminal, so it keeps serving it.
    const app = launchApp(dir, current, legacy)
    await app.router.discoverLegacySessions()
    const attach = await app.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })
    expect(attach.isReattach).toBe(true)
    expect(app.router.getLegacyAdapters()).toEqual([app.legacyAdapter])
    const currentRetirement = vi.spyOn(app.currentAdapter, 'requestIdleRetirement')

    legacy.endSession('old-1')
    await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })
    expect(app.router.getLegacyAdapters()).toEqual([])

    // The current generation keeps serving, empty or not.
    current.endSession(kept.id)
    await vi.waitFor(() => expect(current.server.host.listSessions()).toEqual([]))
    const fresh = await app.router.spawn({ ...size, cwd: dir })
    current.endSession(fresh.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = await app.router.spawn({ ...size, cwd: dir })
    expect(next.id).not.toBe(fresh.id)
    expect(currentRetirement).not.toHaveBeenCalled()
    expect(current.retired).toBe(false)
  })

  it('holds reattaches while the older generation decides, routes them to current after it retires, and never delays a new terminal', async () => {
    const { dir, current, legacy } = await setup()
    const app = launchApp(dir, current, legacy)
    let releaseDecision!: () => void
    const decisionHeld = new Promise<void>((resolve) => (releaseDecision = resolve))
    let decisionAsked!: () => void
    const asked = new Promise<void>((resolve) => (decisionAsked = resolve))
    const decide = app.legacyAdapter.requestIdleRetirement.bind(app.legacyAdapter)
    vi.spyOn(app.legacyAdapter, 'requestIdleRetirement').mockImplementation(async () => {
      // Closes the older generation's own admission at the instant the decision is asked.
      const decision = decide()
      decisionAsked()
      await decisionHeld
      return decision
    })

    await app.router.discoverLegacySessions()
    await asked

    let reattachSettled = false
    const reattach = app.router
      .spawn({ ...size, sessionId: 'restored', cwd: dir })
      .finally(() => (reattachSettled = true))
    const fresh = await app.router.spawn({ ...size, cwd: dir })
    expect(current.server.host.listSessions().map((s) => s.sessionId)).toContain(fresh.id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reattachSettled).toBe(false)

    releaseDecision()
    const restored = await reattach
    await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })
    expect(restored.id).toBe('restored')
    expect(current.server.host.listSessions().map((s) => s.sessionId)).toContain('restored')
    expect(legacy.server.host.listSessions()).toEqual([])
    expect(app.router.getLegacyAdapters()).toEqual([])
  })

  it('asks no decision while a reattach to the older generation is in flight, even once it reads empty', async () => {
    const { dir, current, legacy } = await setup()
    await seedOlderTerminal(legacy, 'old-1')
    await seedOlderTerminal(legacy, 'old-2')
    const app = launchApp(dir, current, legacy)
    await app.router.discoverLegacySessions()
    // Attached, so its exit reaches the app and starts an emptiness check.
    await app.router.spawn({ ...size, sessionId: 'old-2', cwd: dir })
    const decision = vi.spyOn(app.legacyAdapter, 'requestIdleRetirement')
    let releaseSpawn!: () => void
    const spawnHeld = new Promise<void>((resolve) => (releaseSpawn = resolve))
    const spawn = app.legacyAdapter.spawn.bind(app.legacyAdapter)
    vi.spyOn(app.legacyAdapter, 'spawn').mockImplementation(async (opts) => {
      await spawnHeld
      return spawn(opts)
    })

    const reattach = app.router.spawn({ ...size, sessionId: 'old-1', cwd: dir })
    await vi.waitFor(() => expect(app.legacyAdapter.spawn).toHaveBeenCalled())
    legacy.endSession('old-1')
    legacy.endSession('old-2')
    await vi.waitFor(() => expect(legacy.server.host.listSessions()).toEqual([]))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(decision).not.toHaveBeenCalled()

    // The reattach lands after its terminal ended and starts it again there: work the old generation keeps.
    releaseSpawn()
    const result = await reattach
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(legacy.retired).toBe(false)
    expect(legacy.server.host.listSessions().map((s) => s.sessionId)).toEqual([result.id])

    legacy.endSession(result.id)
    await vi.waitFor(() => expect(legacy.retired).toBe(true), { timeout: 5_000 })
    expect(app.router.getLegacyAdapters()).toEqual([])
  })
})
