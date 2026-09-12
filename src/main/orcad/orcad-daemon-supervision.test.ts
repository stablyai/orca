import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  initDaemonPtyProviderMock,
  disconnectDaemonMock,
  shutdownDaemonMock,
  requestIdleDaemonRetirementMock,
  daemonOwnsFreshPersistentPtysMock,
  readDaemonPidRecordMock
} = vi.hoisted(() => ({
  initDaemonPtyProviderMock: vi.fn<(signal?: unknown, options?: unknown) => Promise<void>>(),
  disconnectDaemonMock: vi.fn<() => Promise<void>>(),
  shutdownDaemonMock: vi.fn<() => Promise<void>>(),
  requestIdleDaemonRetirementMock: vi.fn(),
  daemonOwnsFreshPersistentPtysMock: vi.fn<() => boolean>(),
  readDaemonPidRecordMock: vi.fn<() => { pid: number } | null>()
}))

vi.mock('../daemon/daemon-init', () => ({
  initDaemonPtyProvider: initDaemonPtyProviderMock,
  disconnectDaemon: disconnectDaemonMock,
  // Exported here purely so the test can prove it is never reached — killing the daemon on
  // orcad shutdown is what would make an orcad restart destructive again.
  shutdownDaemon: shutdownDaemonMock,
  daemonOwnsFreshPersistentPtys: daemonOwnsFreshPersistentPtysMock,
  readDaemonPidRecord: readDaemonPidRecordMock,
  requestIdleDaemonRetirement: requestIdleDaemonRetirementMock
}))

const { decommissionOrcadDaemonIfIdle, startOrcadDaemon, stopOrcadDaemon } =
  await import('./orcad-daemon-supervision')

const recovery = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('../daemon/daemon-recovery-provider-init', () => ({
  initDaemonRecoveryProvider: recovery.install
}))

beforeEach(() => {
  initDaemonPtyProviderMock.mockResolvedValue()
  disconnectDaemonMock.mockResolvedValue()
  shutdownDaemonMock.mockResolvedValue()
  requestIdleDaemonRetirementMock.mockResolvedValue({ state: 'retiring' })
  daemonOwnsFreshPersistentPtysMock.mockReturnValue(true)
  readDaemonPidRecordMock.mockReturnValue({ pid: 4242 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('startOrcadDaemon', () => {
  it('selects recovery-only installation without launching the normal daemon', async () => {
    await expect(startOrcadDaemon({ recoveryOnly: true })).resolves.toMatchObject({
      state: 'degraded'
    })
    expect(recovery.install).toHaveBeenCalledOnce()
    expect(initDaemonPtyProviderMock).not.toHaveBeenCalled()
  })

  it('does not fall back to spawning after recovery installation fails', async () => {
    recovery.install.mockImplementationOnce(() => {
      throw new Error('recovery unavailable')
    })
    await expect(startOrcadDaemon({ recoveryOnly: true })).rejects.toThrow('recovery unavailable')
    expect(initDaemonPtyProviderMock).not.toHaveBeenCalled()
  })
  it('reports live with the daemon pid once the provider is installed', async () => {
    await expect(startOrcadDaemon()).resolves.toEqual({ state: 'live', pid: 4242 })
  })

  it('does not arm the macOS login-session death watch', async () => {
    await startOrcadDaemon()
    // That watch retires the daemon when the spawning GUI login session dies. An orcad
    // daemon must survive its SSH session ending — arming it would kill every terminal the
    // moment the operator logged out, which is the opposite of the property being bought.
    expect(initDaemonPtyProviderMock).toHaveBeenCalledWith(undefined, {
      macosLoginSessionWatch: false
    })
  })

  it('reports degraded when fresh terminals would fall back to the local provider', async () => {
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    const result = await startOrcadDaemon()
    expect(result.state).toBe('degraded')
  })

  it('fails open when the daemon cannot start at all', async () => {
    initDaemonPtyProviderMock.mockRejectedValue(new Error('node-pty is missing'))
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    // Fail-open, like the desktop: git, worktrees and non-persistent terminals must still
    // serve. What must not happen is a thrown startup or a claim of persistence.
    await expect(startOrcadDaemon()).resolves.toEqual({
      state: 'unavailable',
      reason: 'node-pty is missing'
    })
  })
})

describe('stopOrcadDaemon', () => {
  it('disconnects and never shuts the daemon down', async () => {
    await stopOrcadDaemon()
    expect(disconnectDaemonMock).toHaveBeenCalledTimes(1)
    // The whole point of item 4: an orcad restart is non-destructive only if the daemon
    // outlives it. shutdownDaemon() kills the daemon and every PTY under it.
    expect(shutdownDaemonMock).not.toHaveBeenCalled()
  })
})

describe('decommissionOrcadDaemonIfIdle', () => {
  it('accepts only the daemon atomic idle-retirement verdict', async () => {
    await expect(decommissionOrcadDaemonIfIdle()).resolves.toEqual({ outcome: 'accepted' })
  })

  it('preserves a live terminal verdict', async () => {
    requestIdleDaemonRetirementMock.mockResolvedValueOnce({ state: 'busy', liveSessions: 2 })

    await expect(decommissionOrcadDaemonIfIdle()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_live_sessions'
    })
  })

  it.each([2, 0, null])(
    'preserves explicit native reopening proof (sessions=%s)',
    async (liveSessions) => {
      requestIdleDaemonRetirementMock.mockResolvedValueOnce({
        state: 'busy',
        liveSessions,
        admissionReopened: true
      })
      await expect(decommissionOrcadDaemonIfIdle()).resolves.toMatchObject({
        outcome: 'refused',
        admissionReopened: true
      })
    }
  )

  it('does not manufacture reopening proof for a partial native refusal', async () => {
    requestIdleDaemonRetirementMock.mockResolvedValueOnce({ state: 'busy', liveSessions: 2 })
    expect(await decommissionOrcadDaemonIfIdle()).not.toHaveProperty('admissionReopened')
  })

  it.each([{ state: 'unverifiable' }, { state: 'unsupported' }])(
    'does not infer idle from $state daemon state',
    async (state) => {
      requestIdleDaemonRetirementMock.mockResolvedValueOnce(state)
      await expect(decommissionOrcadDaemonIfIdle()).resolves.toMatchObject({
        outcome: 'refused',
        verdict: 'unverifiable'
      })
    }
  )
})
