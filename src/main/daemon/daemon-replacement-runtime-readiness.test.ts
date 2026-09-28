import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  resolver: vi.fn(),
  sessions: vi.fn(),
  identity: vi.fn(),
  attribution: vi.fn(),
  cleanup: vi.fn(),
  kill: vi.fn()
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ isPackaged: () => false })
}))
vi.mock('./daemon-health', () => ({
  checkDaemonHealth: mocks.health,
  getMacDaemonSystemResolverHealth: mocks.resolver
}))
vi.mock('./daemon-launch-paths', () => ({
  getAliveDaemonSessionCount: mocks.sessions,
  probeDaemonSocket: async () => false,
  DAEMON_SOCKET_PROBE_TIMEOUT_MS: 10
}))
vi.mock('./daemon-pid-identity', () => ({ getDaemonLaunchIdentity: mocks.identity }))
vi.mock('./daemon-endpoint-incarnation', () => ({ readDaemonPidRecord: () => null }))
vi.mock('./daemon-tcc-attribution', () => ({ getMacDaemonTccAttributionHealth: mocks.attribution }))
vi.mock('./daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: mocks.cleanup }))
vi.mock('./daemon-stale-kill', () => ({ killStaleDaemon: mocks.kill }))
vi.mock('./daemon-lifecycle-event', () => ({ trackDaemonReplaced: vi.fn() }))
import { prepareDaemonReplacement } from './daemon-replacement-preflight'
function options() {
  return {
    runtimeDir: '/runtime',
    socketPath: '/socket',
    tokenPath: '/token',
    entryPath: '/entry',
    recoveryDeadlineMs: Date.now() + 1000,
    attributedReason: null,
    launchNonce: 'nonce',
    prepareReplacementRuntime: vi.fn(async () => true),
    releaseAdoptionClient: vi.fn(),
    preserveDaemon: vi.fn(async () => ({ adopted: true as const, shutdown: async () => {} }))
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.health.mockResolvedValue('healthy')
  mocks.resolver.mockResolvedValue('healthy')
  mocks.sessions.mockResolvedValue(0)
  mocks.identity.mockResolvedValue('match')
  mocks.attribution.mockResolvedValue('healthy')
  mocks.cleanup.mockResolvedValue({ cleaned: true })
  mocks.kill.mockResolvedValue({ killed: true, liveOwnerSurvived: false })
})
it.each(['resolver', 'identity', 'attribution', 'unhealthy'])(
  'does not stop an incumbent after runtime preparation fails (%s)',
  async (reason) => {
    if (reason === 'resolver') {
      mocks.resolver.mockResolvedValue('unhealthy')
    }
    if (reason === 'identity') {
      mocks.identity.mockResolvedValue('mismatch')
    }
    if (reason === 'attribution') {
      mocks.attribution.mockResolvedValue('severed')
    }
    if (reason === 'unhealthy') {
      mocks.health.mockResolvedValue('rejected')
    }
    const args = options()
    args.prepareReplacementRuntime.mockRejectedValue(new Error('runtime unavailable'))
    await expect(prepareDaemonReplacement(args)).rejects.toThrow('runtime unavailable')
    expect(mocks.cleanup).not.toHaveBeenCalled()
    expect(mocks.kill).not.toHaveBeenCalled()
    expect(args.releaseAdoptionClient).not.toHaveBeenCalled()
  }
)
it('keeps healthy adoption independent of new runtime files', async () => {
  const args = options()
  args.prepareReplacementRuntime.mockRejectedValue(new Error('missing runtime'))
  expect(await prepareDaemonReplacement(args)).toMatchObject({ adopted: true })
  expect(args.prepareReplacementRuntime).not.toHaveBeenCalled()
})
it('prepares once before protocol cleanup and stale process termination', async () => {
  mocks.identity.mockResolvedValue('mismatch')
  const args = options()
  await prepareDaemonReplacement(args)
  expect(args.prepareReplacementRuntime).toHaveBeenCalledTimes(1)
  expect(args.prepareReplacementRuntime.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.cleanup.mock.invocationCallOrder[0]
  )
  expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.kill.mock.invocationCallOrder[0]
  )
})

it.each([1, null])(
  'preserves an incumbent when preparation changes session evidence to %s',
  async (count) => {
    mocks.identity.mockResolvedValue('mismatch')
    mocks.sessions.mockResolvedValueOnce(0).mockResolvedValue(count)
    expect(await prepareDaemonReplacement(options())).toMatchObject({ adopted: true })
    expect(mocks.cleanup).not.toHaveBeenCalled()
    expect(mocks.kill).not.toHaveBeenCalled()
  }
)

it('retains the prior evidence without a redundant probe when no runtime is materialized', async () => {
  mocks.identity.mockResolvedValue('mismatch')
  const args = options()
  args.prepareReplacementRuntime.mockResolvedValue(false)
  await prepareDaemonReplacement(args)
  expect(mocks.sessions).toHaveBeenCalledOnce()
  expect(mocks.kill).toHaveBeenCalledOnce()
})
it('does not extend an exhausted budget or treat pre-copy emptiness as current proof', async () => {
  mocks.identity.mockResolvedValue('mismatch')
  const args = options()
  const clock = vi.spyOn(Date, 'now')
  clock.mockReturnValue(args.recoveryDeadlineMs - 100)
  args.prepareReplacementRuntime.mockImplementation(async () => {
    clock.mockReturnValue(args.recoveryDeadlineMs)
    return true
  })
  try {
    expect(await prepareDaemonReplacement(args)).toMatchObject({ adopted: true })
    expect(mocks.sessions).toHaveBeenCalledOnce()
    expect(mocks.cleanup).not.toHaveBeenCalled()
    expect(mocks.kill).not.toHaveBeenCalled()
  } finally {
    clock.mockRestore()
  }
})
