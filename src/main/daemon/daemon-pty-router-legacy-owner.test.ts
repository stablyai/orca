import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

const SPAWN = { cols: 80, rows: 24 }

// #26296: after a daemon update, the old daemon keeps the sessions it runs; the new one takes only new ids.
describe('DaemonPtyRouter keeps live sessions on their older daemon', () => {
  it('reattaches on the older daemon when startup discovery could not route the id', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['claude-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(new Error('slow inventory'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await router.spawn({ ...SPAWN, sessionId: 'claude-session' })

    expect(legacy.spawn).toHaveBeenCalledOnce()
    expect(current.spawn).not.toHaveBeenCalled()
    await router.shutdown('claude-session', { immediate: true })
    expect(legacy.shutdown).toHaveBeenCalledOnce()
    expect(current.shutdown).not.toHaveBeenCalled()
  })

  it('keeps the route when another daemon generation reports an exit for the same id', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['claude-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)

    current.emitExit('claude-session', -1)
    router.write('claude-session', 'x')

    expect(legacy.write).toHaveBeenCalledWith('claude-session', 'x')
    expect(current.write).not.toHaveBeenCalled()
  })

  it('refuses rather than duplicating the id when the older daemon cannot answer', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['claude-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await expect(router.spawn({ ...SPAWN, sessionId: 'claude-session' })).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('reconnects through the inventory when the liveness probe cannot reach the older daemon', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['claude-session'])
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.spawn({ ...SPAWN, sessionId: 'claude-session' })
    await router.spawn({ ...SPAWN, sessionId: 'other-session' })

    expect(legacy.spawn).toHaveBeenCalledExactlyOnceWith({ ...SPAWN, sessionId: 'claude-session' })
    expect(current.spawn).toHaveBeenCalledExactlyOnceWith({ ...SPAWN, sessionId: 'other-session' })
  })

  it('reattaches a current-daemon session while an unrelated older daemon cannot answer', async () => {
    const current = createAdapter('current', ['current-session'])
    const legacy = createAdapter('legacy')
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    // A dropped current connection answers the probe with null; the inventory reconnects.
    vi.mocked(current.probePtyLiveness).mockResolvedValue(null)

    await router.spawn({ ...SPAWN, sessionId: 'current-session' })

    expect(current.spawn).toHaveBeenCalledOnce()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('creates on the current daemon once the older daemon no longer runs the id', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.spawn({ ...SPAWN, sessionId: 'exited-session' })
    await router.spawn({ ...SPAWN, sessionId: 'fresh-id', isNewSession: true })
    await router.spawn(SPAWN)

    expect(current.spawn).toHaveBeenCalledTimes(3)
    expect(legacy.spawn).not.toHaveBeenCalled()
    expect(legacy.probePtyLiveness).toHaveBeenCalledOnce()
  })
})
