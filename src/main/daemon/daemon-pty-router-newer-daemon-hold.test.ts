import { describe, expect, it, vi } from 'vitest'

const hold = vi.hoisted(() => ({ holding: false }))
vi.mock('./daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: () => hold.holding
}))
import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'

function setup(opts: { holding: boolean; restorable?: string[]; currentSessions?: string[] }) {
  const current = createAdapter('current', opts.currentSessions ?? [])
  const legacy = createAdapter('legacy', ['legacy-session'])
  const restorable = new Set(opts.restorable ?? [])
  Object.assign(current, { hasRestorableHistory: vi.fn((id: string) => restorable.has(id)) })
  hold.holding = opts.holding
  const router = new DaemonPtyRouter({ current, legacy: [legacy] })
  return { current, legacy, router, release: () => (hold.holding = false) }
}

const SPAWN = { cols: 80, rows: 24 }

describe('DaemonPtyRouter newer-daemon hold', () => {
  it('refuses a cold restore no adopted daemon owns while a newer daemon is held', async () => {
    const { current, router } = setup({ holding: true, restorable: ['newer-session'] })
    await router.discoverLegacySessions()
    await expect(router.spawn({ ...SPAWN, sessionId: 'newer-session' })).rejects.toThrow(
      NEWER_DAEMON_HOLD_ERROR
    )
    expect(current.spawn).not.toHaveBeenCalled()
  })

  // Mobile and runtime restore can re-materialize an existing ID with its agent command.
  it('refuses an agent-launching re-materialize of that id the same way', async () => {
    const { current, router } = setup({ holding: true, restorable: ['newer-session'] })
    await expect(
      router.spawn({
        ...SPAWN,
        sessionId: 'newer-session',
        command: 'claude --resume c1',
        launchAgent: 'claude'
      })
    ).rejects.toThrow(NEWER_DAEMON_HOLD_ERROR)
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('reattaches sessions adopted daemons own', async () => {
    const { current, legacy, router } = setup({
      holding: true,
      restorable: ['legacy-session', 'current-session'],
      currentSessions: ['current-session']
    })
    await router.spawn({ ...SPAWN, sessionId: 'legacy-session' })
    await router.spawn({ ...SPAWN, sessionId: 'current-session' })
    expect(legacy.spawn).toHaveBeenCalledOnce()
    expect(current.spawn).toHaveBeenCalledOnce()
  })

  it('spawns fresh terminals and ids with no saved history', async () => {
    const { current, router } = setup({ holding: true })
    await router.spawn(SPAWN)
    await router.spawn({ ...SPAWN, sessionId: 'pre-allocated-new-id' })
    expect(current.spawn).toHaveBeenCalledTimes(2)
  })

  it('holds when the adopted inventory cannot answer', async () => {
    const { legacy, router } = setup({ holding: true, restorable: ['newer-session'] })
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('timeout'))
    await expect(router.spawn({ ...SPAWN, sessionId: 'newer-session' })).rejects.toThrow(
      NEWER_DAEMON_HOLD_ERROR
    )
  })

  it('restores through the current daemon once the hold is released', async () => {
    const { current, router, release } = setup({ holding: true, restorable: ['newer-session'] })
    await expect(router.spawn({ ...SPAWN, sessionId: 'newer-session' })).rejects.toThrow()
    release()
    await expect(router.spawn({ ...SPAWN, sessionId: 'newer-session' })).resolves.toEqual({
      id: 'newer-session'
    })
    expect(current.spawn).toHaveBeenCalledOnce()
  })

  it('changes nothing for older-daemon routing when no newer daemon is held', async () => {
    const { current, router } = setup({ holding: false, restorable: ['lost-session'] })
    await router.spawn({ ...SPAWN, sessionId: 'lost-session' })
    expect(current.spawn).toHaveBeenCalledOnce()
    expect(current.hasRestorableHistory).not.toHaveBeenCalled()
  })
})
