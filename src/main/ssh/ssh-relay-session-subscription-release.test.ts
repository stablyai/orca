import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

/**
 * Why: teardownProviders drops every subscription the session took out on the mux. No-oping the
 * whole function fails plenty of tests, but no-oping any single release used to fail none — so a
 * subscription left behind here would survive review, and reconnect would re-register on top of
 * it. Each release is asserted individually.
 */

// Why a fresh spy per subscription: one shared cleanup spy cannot tell "this subscription was
// released" from "some other subscription was released", which makes the assertion vacuous.
const { notificationCleanups, notificationByMethodCleanups, registeredPtyProvider } = vi.hoisted(
  () => ({
    notificationCleanups: [] as ReturnType<typeof vi.fn>[],
    notificationByMethodCleanups: [] as ReturnType<typeof vi.fn>[],
    registeredPtyProvider: { dispose: vi.fn(), attachForReconnect: vi.fn() }
  })
)

function trackCleanup(into: ReturnType<typeof vi.fn>[]): ReturnType<typeof vi.fn> {
  const cleanup = vi.fn()
  into.push(cleanup)
  return cleanup
}

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn()
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  allocateSshPtyProviderGeneration: vi.fn(() => 41),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    private disposed = false
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = vi.fn().mockResolvedValue([])
    onNotification = vi.fn(() => trackCleanup(notificationCleanups))
    onNotificationByMethod = vi.fn(() => trackCleanup(notificationByMethodCleanups))
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn(() => () => {})
    dispose = vi.fn(() => {
      this.disposed = true
    })
    isDisposed = vi.fn(() => this.disposed)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: () => false,
  isSshPtyIdentityMismatchError: () => false,
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    setPtyDeliveryPauseAdapter = vi.fn()
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({ SshGitProvider: class MockSshGitProvider {} }))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue(registeredPtyProvider),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { openSshPtyConsumerSession } = await import('./ssh-pty-consumer-session')

// Covers the subscriptions this fixture actually takes out. Still unpinned here: the ack and
// cancellation publishers (installed only on a flow-control-negotiated consumer session) and the
// agent-hook notification handler (remote agent hooks are off in this environment).
const SUBSCRIPTION_RELEASES = [
  ['mux notification handler', notificationCleanups],
  ['pty recovery notification handler', notificationByMethodCleanups]
] as const

async function establishedSession(): Promise<SshRelaySession> {
  const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
  const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
  await session.establish({} as SshConnection)
  return session
}

describe('SshRelaySession subscription release on teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationCleanups.length = 0
    notificationByMethodCleanups.length = 0
    vi.mocked(openSshPtyConsumerSession).mockImplementation(
      async (_mux: unknown, options: { clientInstanceId: string }) => ({
        state: {
          mode: 'legacy-fallback',
          clientInstanceId: options.clientInstanceId,
          serverBuildId: 'test-relay-build'
        },
        resumed: false
      })
    )
    mockDeploySuccess()
  })

  it.each(SUBSCRIPTION_RELEASES)('releases every %s on disposal', async (_label, cleanups) => {
    const session = await establishedSession()
    const held = cleanups.filter((cleanup) => cleanup.mock.calls.length === 0)
    expect(held.length).toBeGreaterThan(0)

    await session.disposeAndPersist()

    for (const cleanup of held) {
      expect(cleanup).toHaveBeenCalled()
    }
  })

  // Positive control: an established session that is never disposed must still hold at least one
  // subscription of each kind, so the assertions above cannot pass on a session that took none out.
  it('still holds subscriptions of every kind while established', async () => {
    await establishedSession()

    for (const [, cleanups] of SUBSCRIPTION_RELEASES) {
      expect(cleanups.filter((cleanup) => cleanup.mock.calls.length === 0).length).toBeGreaterThan(
        0
      )
    }
  })
})
