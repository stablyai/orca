import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { HISTORY_SEED_TRANSFER_PROTOCOL_VERSION, PROTOCOL_VERSION } from './daemon-protocol-version'

function fakeAdapter(
  label: string,
  protocolVersion: number,
  overrides: Partial<DaemonPtyAdapter> = {}
): DaemonPtyAdapter {
  const sessions = new Set<string>()
  return {
    protocolVersion,
    label,
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.add(id)
      return { id }
    }),
    shutdown: vi.fn(async (id: string) => {
      sessions.delete(id)
    }),
    ackColdRestore: vi.fn(),
    hasPty: vi.fn((id: string) => sessions.has(id)),
    listProcesses: vi.fn(async () => [...sessions].map((id) => ({ id, cwd: '', title: label }))),
    dispose: vi.fn(),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onBackgroundStreamEvent: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn(() => () => {}),
    ...overrides
  } as unknown as DaemonPtyAdapter
}

function buildRouter(current: DaemonPtyAdapter, legacy: DaemonPtyAdapter[]): DaemonPtyRouter {
  return new DaemonPtyRouter({ current, legacy })
}

describe('DaemonPtyRouter.sessionsOwnedBy', () => {
  it('reads routed session ids for the given adapter from the owner resolver', async () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const router = buildRouter(current, [legacy])
    await router.spawn({ sessionId: 'held-by-current', cols: 80, rows: 24 } as PtySpawnOptions)
    expect(router.sessionsOwnedBy(current)).toEqual(['held-by-current'])
    expect(router.sessionsOwnedBy(legacy)).toEqual([])
  })
})

describe('DaemonPtyRouter.handoffIdleLegacySession', () => {
  it('checkpoints and kills the legacy PTY, then spawns and routes the replacement on current', async () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const router = buildRouter(current, [legacy])

    const handedOff = await router.handoffIdleLegacySession(legacy, 'idle-session')

    expect(handedOff).toBe(true)
    expect(legacy.shutdown).toHaveBeenCalledWith('idle-session', { keepHistory: true })
    expect(legacy.ackColdRestore).toHaveBeenCalledWith('idle-session')
    expect(current.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'idle-session', isNewSession: false })
    )
    expect(router.sessionsOwnedBy(current)).toEqual(['idle-session'])
    expect(router.sessionsOwnedBy(legacy)).toEqual([])
  })

  it('never fires when the legacy owner fails the seed-transfer version gate', async () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy-v30', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION)
    const router = buildRouter(current, [legacy])

    const handedOff = await router.handoffIdleLegacySession(legacy, 'idle-session')

    expect(handedOff).toBe(false)
    expect(legacy.shutdown).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('leaves no route recorded when the replacement spawn reports exitedBeforeSpawnReply', async () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION, {
      spawn: vi.fn(async (): Promise<PtySpawnResult> => ({
        id: 'idle-session',
        exitedBeforeSpawnReply: true
      }))
    })
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const router = buildRouter(current, [legacy])

    const handedOff = await router.handoffIdleLegacySession(legacy, 'idle-session')

    expect(handedOff).toBe(false)
    // Why: the legacy PTY is already gone (shutdown ran), but the new one never proved
    // alive, so neither adapter may claim the route -- a later external attach falls
    // through to `current` (the router's own default) and retries the cold restore.
    expect(router.sessionsOwnedBy(current)).toEqual([])
    expect(router.sessionsOwnedBy(legacy)).toEqual([])
  })

  it('aborts without touching the route when the legacy checkpoint-and-kill itself fails', async () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1, {
      shutdown: vi.fn(async () => {
        throw new Error('daemon unreachable')
      })
    })
    const router = buildRouter(current, [legacy])

    const handedOff = await router.handoffIdleLegacySession(legacy, 'idle-session')

    expect(handedOff).toBe(false)
    expect(current.spawn).not.toHaveBeenCalled()
  })
})

describe('DaemonPtyRouter.retireLegacyAdapter', () => {
  it('removes the adapter from legacy, disposes it, and stops it appearing in getAllAdapters', () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const router = buildRouter(current, [legacy])

    router.retireLegacyAdapter(legacy)

    expect(router.getLegacyAdapters()).toEqual([])
    expect(router.getAllAdapters()).toEqual([current])
    expect(legacy.dispose).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an adapter that is not (or no longer) in the legacy array', () => {
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const stranger = fakeAdapter('stranger', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const router = buildRouter(current, [legacy])

    router.retireLegacyAdapter(stranger)

    expect(router.getLegacyAdapters()).toEqual([legacy])
    expect(stranger.dispose).not.toHaveBeenCalled()
  })

  it('removes the adapter from the owner resolver too, not only from legacy', async () => {
    // Why this test exists: a disposed adapter left in the owner resolver's poll set
    // rejects forever, which blocks `complete` from ever being true again and
    // degrades every later ownership resolution on the WHOLE router to 'unknown' --
    // not only for the retired generation. The class-level proof lives in
    // daemon-session-owner-resolution-provider-removal.test.ts; this asserts the
    // router actually wires retireLegacyAdapter() to it.
    const current = fakeAdapter('current', PROTOCOL_VERSION)
    const legacy = fakeAdapter('legacy', HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const router = buildRouter(current, [legacy])
    const routerInternals = router as unknown as {
      ownerResolver: { removeProvider: (adapter: DaemonPtyAdapter) => void }
    }
    const removeProviderSpy = vi.spyOn(routerInternals.ownerResolver, 'removeProvider')

    router.retireLegacyAdapter(legacy)

    expect(removeProviderSpy).toHaveBeenCalledWith(legacy)
  })
})
