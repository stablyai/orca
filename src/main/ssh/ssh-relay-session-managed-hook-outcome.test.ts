// Why (#8711): reproduced live against a real Linux SSH target — the remote
// managed hook install produced no `~/.codex/hooks.json` and no
// `~/.orca/agent-hooks/` script, yet the client discarded the install result
// after a console.warn, so `agent hooks status` had nothing but the local
// machine to report. Every outcome now leaves a per-host verdict behind, and
// the default is `unknown` rather than silence.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD } from '../../shared/agent-hook-relay'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputDataMock, muxRequestMock, openConsumerSessionMock, pauseAdapterMock } =
  vi.hoisted(() => ({
    acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
    muxRequestMock: vi.fn(),
    openConsumerSessionMock: vi.fn(),
    pauseAdapterMock: vi.fn()
  }))

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))

vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: acceptOutputDataMock,
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

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('./ssh-channel-multiplexer', () => {
  return {
    SshChannelMultiplexer: class MockSshChannelMultiplexer {
      notify = vi.fn()
      notifyWithSettlement = vi.fn()
      request = muxRequestMock
      onNotification = vi.fn().mockReturnValue(() => {})
      onNotificationByMethod = vi.fn().mockReturnValue(() => {})
      onRequest = vi.fn().mockReturnValue(() => {})
      onDispose = vi.fn().mockReturnValue(() => {})
      dispose = vi.fn()
      isDisposed = vi.fn().mockReturnValue(false)
    }
  }
})

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('not found'),
  isSshPtyIdentityMismatchError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('identity mismatch'),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    setPtyDeliveryPauseAdapter = pauseAdapterMock
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))

vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    attachForReconnect: vi.fn().mockResolvedValue({})
  }),
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

function createSession(): SshRelaySession {
  const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
  return new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
}

async function establishAndSettle(session: SshRelaySession): Promise<void> {
  await session.establish({} as SshConnection)
  await vi.waitFor(() => expect(session.getManagedHookOutcome().state).not.toBe('unknown'))
}

describe('SshRelaySession managed hook outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  it('defaults to unknown before the install reports — never to the local answer', () => {
    expect(createSession().getManagedHookOutcome()).toMatchObject({ state: 'unknown' })
  })

  it('records the per-agent result the remote host reported', async () => {
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        return {
          installers: 1,
          errors: 1,
          statuses: [
            {
              agent: 'codex',
              state: 'error',
              configPath: '/home/dev/.codex/hooks.json',
              managedHooksPresent: false,
              detail: 'Could not parse remote Codex hooks.json'
            }
          ]
        }
      }
      return { ok: true }
    })
    const session = createSession()

    await establishAndSettle(session)

    const outcome = session.getManagedHookOutcome()
    expect(outcome.state).toBe('error')
    expect(outcome.statuses[0]).toMatchObject({ agent: 'codex', state: 'error' })
  })

  it('records skipped — not installed — when the remote host has no agent CLI', async () => {
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: [] }
      }
      return { ok: true }
    })
    const session = createSession()

    await establishAndSettle(session)

    expect(session.getManagedHookOutcome()).toMatchObject({
      state: 'skipped',
      detail: 'No managed agent CLI was detected on the remote host.'
    })
    expect(
      muxRequestMock.mock.calls.some(
        ([method]) => method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
      )
    ).toBe(false)
  })

  it('records error when the install RPC throws for a live connection', async () => {
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        throw new Error('remote install blew up')
      }
      return { ok: true }
    })
    const session = createSession()

    await establishAndSettle(session)

    expect(session.getManagedHookOutcome()).toMatchObject({
      state: 'error',
      detail: 'remote install blew up'
    })
  })

  it('stays unknown when the connection dropped mid-install rather than blaming the host', async () => {
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        throw Object.assign(new Error('connection lost'), { code: 'CONNECTION_LOST' })
      }
      return { ok: true }
    })
    const session = createSession()
    await session.establish({} as SshConnection)
    await vi.waitFor(() =>
      expect(session.getManagedHookOutcome().detail).toContain('could not be confirmed')
    )

    expect(session.getManagedHookOutcome().state).toBe('unknown')
  })
})
