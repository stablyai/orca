/* What a degraded-mode PTY's absence proves. The routed provider's own coverage lives in
 * daemon-watched-exit-absence-verdict.test.ts; degraded mode reaches the same daemon through a
 * different layer, and it is that layer — not the adapter's certificates — that these cases
 * drive. Both directions below turn on the same fact: the certificate is scoped to the
 * incarnation it proves, and only the adapter that issued it may retire it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider } from '../providers/types'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonServer } from './daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import { inspectPtyProviderProcessForRenderer } from '../providers/pty-process-inspection'
import { buildAbsentPtyInspection } from '../../shared/pty-process-inspection-evidence'

const itOnPosix = process.platform === 'win32' ? it.skip : it

/** Degraded mode always carries a local fallback; this one owns nothing, so every answer
 *  in these cases comes from the daemon route under test. */
function neverOwningFallback(): IPtyProvider {
  return {
    hasPty: () => false,
    onData: () => () => {},
    onExit: () => () => {},
    onReplay: () => () => {}
  } as unknown as IPtyProvider
}

/**
 * The degraded twin of the routed finalization case. `resultForExitBeforeSpawnReply` is
 * consulted twice and `finishSpawn` then continues through several more awaits; a PTY that
 * dies in one of those windows is watched and certified by the real daemon while the spawn
 * result already in hand still says it came up live. `exitedBeforeSpawnReply` is therefore
 * unset here, which is exactly why it cannot be the thing that decides whether the
 * certificate survives.
 *
 * Hooked on `historyManager.openSession` because it is the first awaited step AFTER
 * `markSessionActive`, which isolates the degraded provider's spawn path as the only thing
 * that can discard the certificate. The exit is real: the mock shell's exit travels the
 * daemon's socket and only proceeds once the adapter has actually issued the certificate.
 */
describe('a degraded-mode exit that lands inside spawn finalization', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    ;({ dir, server } = harness)
    harness.adapter.dispose()
    // A history path is what gives the adapter a HistoryManager, and with it the awaited
    // `openSession` step that production spawns really do run.
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(dir, 'history')
    })
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  itOnPosix(
    'keeps the certificate the exit issued while the spawn was still finishing',
    async () => {
      const historyManager = adapter.getHistoryManager()
      expect(
        historyManager,
        'the finalization window only exists with a history manager'
      ).not.toBeNull()
      const provider = new DegradedDaemonPtyProvider({
        current: adapter,
        legacy: [],
        fallback: neverOwningFallback(),
        probeCurrentDaemonSpawn: async () => true
      })
      let certifiedDuringSpawn = false
      const openSession = historyManager!.openSession.bind(historyManager!)
      vi.spyOn(historyManager!, 'openSession').mockImplementation(async (sessionId, opts) => {
        lastSubprocess._simulateExit(0)
        // Proves the evidence exists BEFORE the layer under test gets to discard it.
        await waitFor(() => adapter.ptyAbsenceVerdict(sessionId) === 'exited')
        certifiedDuringSpawn = true
        return await openSession(sessionId, opts)
      })
      try {
        // Degraded mode spawns fresh terminals on the fallback until the daemon proves healthy;
        // this is the recovered state, where a fresh spawn is daemon-backed again.
        await provider.recoverFreshSpawnRouting()
        const result = await provider.spawn({ cols: 80, rows: 24 })

        expect(certifiedDuringSpawn).toBe(true)
        // The gate the earlier round added does not fire here: the reply was already formed.
        expect(result.exitedBeforeSpawnReply).toBeFalsy()

        // The bytes the renderer reads: `unavailable` is what raises the running-process dialog
        // and holds completion monitoring open, so a watched exit must not carry it.
        const inspection = await inspectPtyProviderProcessForRenderer(provider, result.id)
        expect(
          inspection,
          'an exit the daemon watched must not be erased by the degraded spawn that raced it'
        ).toEqual(buildAbsentPtyInspection('exited'))
        expect(inspection).not.toHaveProperty('unavailable')
      } finally {
        provider.disposeProviderOnly()
      }
    }
  )
})

/**
 * The other half of the same rule, and the direction fixing the first one alone converts it
 * into: a session id is derived from the pane and reused on reopen, so a generation that
 * watched the previous run die still holds a certificate filed against the id its replacement
 * now uses. Only the issuing adapter can retire that certificate, so a spawn that reaches just
 * the adapter it routed to leaves every sibling generation still vouching for a live pane —
 * and the degraded router, which forgets a route the moment a session exits, falls back to
 * exactly those siblings when it can no longer route the id.
 */
describe('a superseded generation holding a certificate for a reused session id', () => {
  let legacyDir: string
  let currentDir: string
  let legacyServer: DaemonServer
  let currentServer: DaemonServer
  let legacy: DaemonPtyAdapter
  let current: DaemonPtyAdapter
  let legacySubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const legacyHarness = await startDaemonAdapterHarness(() => {
      legacySubprocess = createMockSubprocess()
      return legacySubprocess
    })
    legacyDir = legacyHarness.dir
    legacyServer = legacyHarness.server
    legacy = legacyHarness.adapter
    const currentHarness = await startDaemonAdapterHarness(() => createMockSubprocess())
    currentDir = currentHarness.dir
    currentServer = currentHarness.server
    current = currentHarness.adapter
  })

  afterEach(async () => {
    legacy?.dispose()
    current?.dispose()
    await legacyServer?.shutdown()
    await currentServer?.shutdown()
    rmSync(legacyDir, { recursive: true, force: true })
    rmSync(currentDir, { recursive: true, force: true })
  })

  itOnPosix('stops it answering for the replacement the degraded router spawned', async () => {
    const sessionId = 'reused-pane-session'
    // The previous generation: a real session on the legacy daemon, watched all the way to
    // its exit, so the certificate under test is one the daemon actually issued.
    await legacy.spawn({ cols: 80, rows: 24, sessionId })
    legacySubprocess._simulateExit(0)
    await waitFor(() => legacy.ptyAbsenceVerdict(sessionId) === 'exited')

    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [legacy],
      fallback: neverOwningFallback(),
      probeCurrentDaemonSpawn: async () => true
    })
    try {
      await provider.recoverFreshSpawnRouting()
      // Reopening the pane reuses the id, and degraded mode routes the fresh spawn to the
      // current daemon — a generation that has never heard of the legacy certificate.
      const result = await provider.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)

      expect(
        legacy.ptyAbsenceVerdict(sessionId),
        'a retired generation must not keep certifying the id its replacement now uses'
      ).toBe('unverifiable')
    } finally {
      provider.disposeProviderOnly()
    }
  })
})
