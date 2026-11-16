import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'

const SPAWN = { cols: 80, rows: 24 }
// Keep the fake PID outside the real process range.
const MISSING_PID = 2_147_483_000

describe('DaemonPtyRouter keeps live sessions on their older daemon', () => {
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
})
