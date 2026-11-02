import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

const SPAWN = { cols: 80, rows: 24 }
// Keep the fake PID outside the real process range.
const MISSING_PID = 2_147_483_000

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

    // Model reconnect through inventory after the current connection drops.
    vi.mocked(current.probePtyLiveness).mockResolvedValue(null)

    await router.spawn({ ...SPAWN, sessionId: 'current-session' })

    expect(current.spawn).toHaveBeenCalledOnce()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('refuses while the older daemon socket answers even if its pid is gone', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['claude-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    vi.mocked(legacy.getLastAuthenticatedDaemonIdentity).mockReturnValue({
      pid: MISSING_PID,
      startedAtMs: 0,
      launchNonce: 'legacy'
    })
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.spawn({ ...SPAWN, sessionId: 'claude-session' })).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'creates on the current daemon once the older daemon socket and pid are both gone',
    async () => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy', ['claude-session'])
      vi.mocked(legacy.listProcesses).mockRejectedValue(
        Object.assign(new Error('connect ENOENT'), { code: 'ENOENT', syscall: 'connect' })
      )
      vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
      vi.mocked(legacy.getLastAuthenticatedDaemonIdentity).mockReturnValue({
        pid: MISSING_PID,
        startedAtMs: 0,
        launchNonce: 'legacy'
      })
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await router.spawn({ ...SPAWN, sessionId: 'claude-session' })

      expect(current.spawn).toHaveBeenCalledOnce()
    }
  )
})
