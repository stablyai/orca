import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stale: vi.fn(),
  journal: vi.fn(),
  fence: vi.fn(),
  takeover: vi.fn()
}))
vi.mock('./ssh-relay-install-lock', () => ({
  isRelayInstallLockStale: mocks.stale,
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.journal
}))
vi.mock('./orcad-activation-lock', () => ({
  orcadActivationFenceExists: mocks.fence,
  withStaleOrcadActivationRecoveryLock: mocks.takeover
}))

const { orcadActivationFenceRefusal } = await import('./orcad-activation-fence-hold')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every reader of these options is mocked.
const options = { host: { os: 'linux', pathFlavor: 'posix' }, remoteHome: '/home/u' } as never

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stale.mockResolvedValue(false)
  mocks.journal.mockResolvedValue(null)
  mocks.fence.mockResolvedValue(true)
  mocks.takeover.mockImplementation(async (_options, run) => run({ retain: vi.fn() }))
})

describe('orcadActivationFenceRefusal', () => {
  it('reads a fresh fence as busy, even over a live run journal', async () => {
    mocks.journal.mockResolvedValue({ operation: 'activate' })
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_fence_busy'
    })
  })

  it('asks for Recover only for a stale lock over a journal, or a journal no fence guards', async () => {
    mocks.journal.mockResolvedValue({ operation: 'activate' })
    mocks.stale.mockResolvedValueOnce(true)
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_recovery_required'
    })
    mocks.fence.mockResolvedValue(false)
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_recovery_required'
    })
    expect(mocks.takeover).not.toHaveBeenCalled()
  })

  // BUG-21: a wake cut short left a bare stale fence; every update said "Recover it first" while
  // Recover answered "none".
  it('clears a stale fence no journal backs, so the attempt can run again', async () => {
    mocks.stale.mockResolvedValue(true)
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_fence_busy',
      cleared: true
    })
    expect(mocks.takeover).toHaveBeenCalledOnce()
  })

  it('keeps a fence whose journal appeared under the takeover, and asks for Recover', async () => {
    mocks.stale.mockResolvedValue(true)
    mocks.journal.mockResolvedValueOnce(null).mockResolvedValue({ operation: 'activate' })
    const retain = vi.fn()
    mocks.takeover.mockImplementation(async (_options, run) => run({ retain }))
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_recovery_required'
    })
    expect(retain).toHaveBeenCalledOnce()
  })
})
