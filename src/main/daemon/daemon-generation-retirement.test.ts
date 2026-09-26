import { describe, expect, it, vi } from 'vitest'
import {
  DaemonGenerationRetirementScheduler,
  type DaemonGenerationRetirementDeps
} from './daemon-generation-retirement'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonHealth } from './daemon-health'

type FakeLegacyAdapter = DaemonPtyAdapter & {
  listSessions: ReturnType<typeof vi.fn>
  hasChildProcesses: ReturnType<typeof vi.fn>
  listProcesses: ReturnType<typeof vi.fn>
}

function fakeLegacyAdapter(
  protocolVersion: number,
  opts: {
    sessions?: { sessionId: string; busy: boolean }[]
    processIds?: string[]
  } = {}
): FakeLegacyAdapter {
  const sessions = opts.sessions ?? []
  const processIds = opts.processIds ?? sessions.map((s) => s.sessionId)
  return {
    protocolVersion,
    listSessions: vi.fn(async () => sessions.map((s) => ({ sessionId: s.sessionId }))),
    hasChildProcesses: vi.fn(
      async (id: string) => sessions.find((s) => s.sessionId === id)?.busy ?? false
    ),
    listProcesses: vi.fn(async () => processIds.map((id) => ({ id, cwd: '', title: '' })))
  } as unknown as FakeLegacyAdapter
}

function fakeCurrentAdapter(): DaemonPtyAdapter {
  return { protocolVersion: 36 } as DaemonPtyAdapter
}

function fakeRouter(opts: {
  legacy: DaemonPtyAdapter[]
  current?: DaemonPtyAdapter
  handoffResult?: boolean
  sessionsOwnedByCurrent?: string[]
}): DaemonPtyRouter & {
  handoffIdleLegacySession: ReturnType<typeof vi.fn>
  retireLegacyAdapter: ReturnType<typeof vi.fn>
  sessionsOwnedBy: ReturnType<typeof vi.fn>
} {
  const current = opts.current ?? fakeCurrentAdapter()
  return {
    getLegacyAdapters: vi.fn(() => opts.legacy),
    getCurrentAdapter: vi.fn(() => current),
    handoffIdleLegacySession: vi.fn(async () => opts.handoffResult ?? true),
    retireLegacyAdapter: vi.fn(),
    sessionsOwnedBy: vi.fn((adapter: DaemonPtyAdapter) =>
      adapter === current ? (opts.sessionsOwnedByCurrent ?? []) : []
    )
  } as unknown as DaemonPtyRouter & {
    handoffIdleLegacySession: ReturnType<typeof vi.fn>
    retireLegacyAdapter: ReturnType<typeof vi.fn>
    sessionsOwnedBy: ReturnType<typeof vi.fn>
  }
}

function baseDeps(
  overrides: Partial<DaemonGenerationRetirementDeps> = {}
): DaemonGenerationRetirementDeps {
  return {
    router: fakeRouter({ legacy: [] }),
    runtimeDir: '/fake/runtime',
    now: () => 0,
    sleep: vi.fn(async () => {}),
    killPid: vi.fn(),
    isPidAlive: vi.fn(() => false),
    checkHealth: vi.fn(async (): Promise<DaemonHealth> => 'healthy'),
    readPidFile: vi.fn(() => JSON.stringify({ pid: 4242, launchNonce: 'nonce-1' })),
    readTokenFile: vi.fn(() => 'token-contents'),
    unlinkPidFile: vi.fn(() => true),
    unlinkTokenFile: vi.fn(() => true),
    trackRetired: vi.fn(),
    ...overrides
  }
}

describe('DaemonGenerationRetirementScheduler Tier-1/Tier-2 split', () => {
  it('hands off only idle sessions and never touches a busy one', async () => {
    const legacy = fakeLegacyAdapter(22, {
      sessions: [
        { sessionId: 'idle-1', busy: false },
        { sessionId: 'busy-1', busy: true }
      ]
    })
    const router = fakeRouter({ legacy: [legacy] })
    const scheduler = new DaemonGenerationRetirementScheduler(baseDeps({ router }))

    await scheduler.tick()

    expect(router.handoffIdleLegacySession).toHaveBeenCalledTimes(1)
    expect(router.handoffIdleLegacySession).toHaveBeenCalledWith(legacy, 'idle-1')
  })

  it('treats a session whose busy state could not be proven as busy, never handing it off', async () => {
    const legacy = fakeLegacyAdapter(22, { sessions: [{ sessionId: 'unproven', busy: false }] })
    legacy.hasChildProcesses.mockRejectedValueOnce(new Error('rpc timeout'))
    const router = fakeRouter({ legacy: [legacy] })
    const scheduler = new DaemonGenerationRetirementScheduler(baseDeps({ router }))

    await scheduler.tick()

    expect(router.handoffIdleLegacySession).not.toHaveBeenCalled()
  })
})

describe('DaemonGenerationRetirementScheduler verification gate', () => {
  it('never retires a generation that still owns an unmigrated session', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: ['still-there'] })
    const router = fakeRouter({ legacy: [legacy], sessionsOwnedByCurrent: [] })
    const killPid = vi.fn()
    const scheduler = new DaemonGenerationRetirementScheduler(baseDeps({ router, killPid }))

    await scheduler.tick()

    expect(killPid).not.toHaveBeenCalled()
    expect(router.retireLegacyAdapter).not.toHaveBeenCalled()
    expect(scheduler.getState(legacy)).toBe('handoff-in-progress')
  })

  it('accepts empty as either zero processes or every remaining process owned by current', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: ['migrated'] })
    const router = fakeRouter({ legacy: [legacy], sessionsOwnedByCurrent: ['migrated'] })
    const killPid = vi.fn()
    const scheduler = new DaemonGenerationRetirementScheduler(baseDeps({ router, killPid }))

    await scheduler.tick()

    expect(killPid).toHaveBeenCalled()
  })
})

describe('DaemonGenerationRetirementScheduler recycled-pid guard (4.3.2)', () => {
  it('refuses to signal when the health probe disagrees with the pid record', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const killPid = vi.fn()
    const checkHealth = vi.fn(async (): Promise<DaemonHealth> => 'unreachable')
    const scheduler = new DaemonGenerationRetirementScheduler(
      baseDeps({ router, killPid, checkHealth })
    )

    await scheduler.tick()

    expect(checkHealth).toHaveBeenCalled()
    expect(killPid).not.toHaveBeenCalled()
    expect(router.retireLegacyAdapter).not.toHaveBeenCalled()
  })

  it('refuses to signal a rejected handshake the same as an unreachable one', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const killPid = vi.fn()
    const checkHealth = vi.fn(async (): Promise<DaemonHealth> => 'rejected')
    const scheduler = new DaemonGenerationRetirementScheduler(
      baseDeps({ router, killPid, checkHealth })
    )

    await scheduler.tick()

    expect(killPid).not.toHaveBeenCalled()
  })

  it('aborts without signaling when the on-disk pid record cannot be read', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const killPid = vi.fn()
    const readPidFile = vi.fn(() => {
      throw new Error('ENOENT')
    })
    const scheduler = new DaemonGenerationRetirementScheduler(
      baseDeps({ router, killPid, readPidFile })
    )

    await scheduler.tick()

    expect(killPid).not.toHaveBeenCalled()
  })
})

describe('DaemonGenerationRetirementScheduler retirement (4.4)', () => {
  it('sends SIGTERM, unlinks the pid/token records, retires the adapter and emits telemetry once healthy and empty', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const killPid = vi.fn()
    const isPidAlive = vi.fn(() => false)
    const unlinkPidFile = vi.fn(() => true)
    const unlinkTokenFile = vi.fn(() => true)
    const trackRetired = vi.fn()
    const scheduler = new DaemonGenerationRetirementScheduler(
      baseDeps({ router, killPid, isPidAlive, unlinkPidFile, unlinkTokenFile, trackRetired })
    )

    await scheduler.tick()

    expect(killPid).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(killPid).not.toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(unlinkPidFile).toHaveBeenCalledWith(
      expect.stringContaining('/fake/runtime'),
      4242,
      'nonce-1'
    )
    expect(unlinkTokenFile).toHaveBeenCalledWith(
      expect.stringContaining('/fake/runtime'),
      'token-contents'
    )
    expect(router.retireLegacyAdapter).toHaveBeenCalledWith(legacy)
    expect(trackRetired).toHaveBeenCalledWith('generation_handoff_complete')
    expect(scheduler.getState(legacy)).toBe('retired')
  })

  it('escalates to SIGKILL only after the daemon outlives the bounded grace window', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const killPid = vi.fn()
    let elapsed = 0
    // Why 6_000 and not 5_000: the process must still be alive AFTER the first
    // (SIGTERM) grace window elapses at 5_000, so the scheduler escalates to
    // SIGKILL, and only then die -- proving the escalation actually fires rather
    // than the loop merely timing out on its own.
    const isPidAlive = vi.fn(() => elapsed < 6_000)
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms
    })
    const scheduler = new DaemonGenerationRetirementScheduler(
      baseDeps({
        router,
        killPid,
        isPidAlive,
        sleep,
        now: () => elapsed,
        sigkillGraceMs: 5_000
      })
    )

    await scheduler.tick()

    expect(killPid).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(killPid).toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(router.retireLegacyAdapter).toHaveBeenCalledWith(legacy)
  })

  it('never unlinks records or retires the adapter when the process survives SIGKILL too', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const unlinkPidFile = vi.fn(() => true)
    let elapsed = 0
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms
    })
    const scheduler = new DaemonGenerationRetirementScheduler(
      baseDeps({
        router,
        isPidAlive: vi.fn(() => true),
        unlinkPidFile,
        sleep,
        now: () => elapsed,
        sigkillGraceMs: 100
      })
    )

    await scheduler.tick()

    expect(unlinkPidFile).not.toHaveBeenCalled()
    expect(router.retireLegacyAdapter).not.toHaveBeenCalled()
  })
})

describe('DaemonGenerationRetirementScheduler reentrancy', () => {
  it('coalesces overlapping tick() calls into a single in-flight pass', async () => {
    const legacy = fakeLegacyAdapter(22, { processIds: [] })
    const router = fakeRouter({ legacy: [legacy] })
    const scheduler = new DaemonGenerationRetirementScheduler(baseDeps({ router }))

    const first = scheduler.tick()
    const second = scheduler.tick()
    await Promise.all([first, second])

    expect(router.getLegacyAdapters).toHaveBeenCalledTimes(1)
  })

  it('start() and stop() do not throw and stop() is idempotent', () => {
    const scheduler = new DaemonGenerationRetirementScheduler(baseDeps())
    expect(() => scheduler.start()).not.toThrow()
    expect(() => scheduler.stop()).not.toThrow()
    expect(() => scheduler.stop()).not.toThrow()
  })
})
