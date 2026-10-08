import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock(
  '../ssh/ssh-previous-relay-terminals',
  () => import('../ssh/ssh-previous-relay-census-test-double')
)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { SshPtyHeldByPreviousRelayError } from '../providers/ssh-pty-errors'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getSshPtyProvider,
  getPtyIdsForConnection
} from './pty'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { setCurrentRuntime } from './ssh-ipc-context'

const { mockSshStore, mockConnectionManager, mockPtyProvider, mockPortForwardManager } = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore } = harness

  beforeEach(harness.reset)

  it('ssh:terminateSessions refuses a removal of a managed server host before ending anything', async () => {
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      orcadFence: { environmentId: 'env-1' }
    })
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])
    expect(() =>
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1', forRemoval: true })
    ).toThrow('Settings › Managed servers')
    expect(mockPtyProvider.shutdown).not.toHaveBeenCalled()
  })

  it('ssh:terminateSessions preserves tracking when relay shutdown fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])
    mockPtyProvider.shutdown.mockRejectedValue(new Error('mux down'))

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).rejects.toThrow('Failed to terminate SSH host sessions')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith('ssh-1', 'pty-1', 'terminated')
    expect(mockConnectionManager.disconnect).not.toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:terminateSessions cleans scoped live PTYs while tombstoning raw leases', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-lease', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['ssh:ssh-1@@pty-live'])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 2, unverifiable: 0 })

    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-live', {
      immediate: true,
      keepHistory: false
    })
    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease', {
      immediate: true,
      keepHistory: false
    })
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:ssh-1@@pty-live')
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:ssh-1@@pty-live')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-live', 'terminated')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-lease', 'terminated')
  })

  it('keeps reconnect behind the complete terminate-sessions lifecycle', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let resolveShutdown!: () => void
    let resolveForwardRemoval!: () => void
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveShutdown = resolve
      })
    )
    mockPortForwardManager.removeAllForwards.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveForwardRemoval = resolve
        })
    )

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    const terminate = handlers.get('ssh:terminateSessions')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    await vi.waitFor(() => expect(mockPtyProvider.shutdown).toHaveBeenCalledOnce())
    const reconnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)

    resolveShutdown()
    await vi.waitFor(() => expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1'))
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    resolveForwardRemoval()
    await terminate
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(2))

    await expect(reconnect).resolves.toMatchObject({ targetId: 'ssh-1', status: 'connected' })
  })

  // Issue #12661: an offline sweep tears down local transport only. Reporting plain success would
  // read as "the remote shells are gone" when nobody asked the host.
  it('ssh:terminateSessions reports superseded leases as unverifiable without a relay', async () => {
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-expired', state: 'expired', supersededBy: 'pty-2' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(undefined)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 0, unverifiable: 1 })

    expect(mockPtyProvider.shutdown).not.toHaveBeenCalled()
    // Still no forced reconnect: a newer lease won this pane, so this route died for good and must
    // never block a target the user is trying to remove (#2626).
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'ssh-1',
      'pty-expired',
      'terminated'
    )
  })

  it('ssh:terminateSessions leaves a recycled relay id out of the reconnect fence', async () => {
    // The host listed this id under a different PTY incarnation, so it no longer routes to this
    // lease's shell — reconnecting could only aim the stop at a stranger's process.
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-recycled', state: 'expired', relayIdRecycled: true }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(undefined)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 0, unverifiable: 1 })
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  // An `expired` lease carrying neither retirement mark is an orphan, not a corpse: it records only
  // that this client lost its route. Answering `unverifiable` there strands a remote shell the user
  // just ordered stopped, when a reconnect is exactly what would reach it.
  it('ssh:terminateSessions demands a reconnect for an unmarked expired lease', async () => {
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-orphan', state: 'expired' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(undefined)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).rejects.toThrow(SSH_TERMINATE_RECONNECT_REQUIRED)

    expect(mockPtyProvider.shutdown).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'ssh-1',
      'pty-orphan',
      'terminated'
    )
  })

  it('ssh:terminateSessions reports nothing unverifiable when there is nothing to reach', async () => {
    mockStore.getSshRemotePtyLeases.mockReturnValue([])
    vi.mocked(getSshPtyProvider).mockReturnValue(undefined)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 0, unverifiable: 0 })
  })

  it('ssh:terminateSessions kills expired leases whose remote PTY may still be alive', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-abandoned', state: 'expired' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })

    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-abandoned', {
      immediate: true,
      keepHistory: false
    })
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'ssh-1',
      'pty-abandoned',
      'terminated'
    )
  })

  it('ssh:terminateSessions stops a shell the relay runs without any lease here', async () => {
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    mockConnectionManager.connect.mockResolvedValue({})
    mockStore.getSshRemotePtyLeases.mockReturnValue([])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    // A CLI-created terminal: the relay lists it, but no lease or local pane knows it.
    mockPtyProvider.listProcesses.mockResolvedValue([{ id: 'ssh:ssh-1@@pty-cli' }])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toMatchObject({ terminated: 1, unverifiable: 0 })

    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-cli', {
      immediate: true,
      keepHistory: false
    })
  })

  it('ssh:terminateSessions tombstones an expired lease the relay reports gone', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-abandoned', state: 'expired' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockRejectedValue(new Error('PTY "pty-abandoned" not found'))

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })

    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'ssh-1',
      'pty-abandoned',
      'terminated'
    )
  })

  it('ssh:terminateSessions keeps a lease an older relay holds but no route can stop', async () => {
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty2:old:1', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockRejectedValue(new SshPtyHeldByPreviousRelayError('pty2:old:1'))

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 0, unverifiable: 1 })
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'ssh-1',
      'pty2:old:1',
      'terminated'
    )
  })

  it('ssh:terminateSessions leaves leases it already proved terminated alone', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-tombstoned', state: 'terminated' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })

    expect(mockPtyProvider.shutdown).not.toHaveBeenCalled()
  })

  it('ssh:terminateSessions keeps an expired lease when its shutdown fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-abandoned', state: 'expired' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockRejectedValue(new Error('mux down'))

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).rejects.toThrow('Failed to terminate SSH host sessions')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'ssh-1',
      'pty-abandoned',
      'terminated'
    )
  })

  it('ssh:terminateSessions tells the runtime a stopped shell is no longer connected', async () => {
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([
      'ssh:ssh-1@@pty-lost-exit',
      'ssh:ssh-1@@pty-reported-exit'
    ])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)
    const runtime = {
      getPtyLivenessVerdict: vi.fn((ptyId: string) =>
        ptyId.endsWith('pty-reported-exit') ? { status: 'exited' } : null
      ),
      onPtyExit: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminate reads only these two runtime methods.
    setCurrentRuntime(runtime as never)

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 2, unverifiable: 0 })

    // The stop sentinel, never a certified death; an exit the relay already reported stands.
    expect(runtime.onPtyExit.mock.calls).toEqual([['ssh:ssh-1@@pty-lost-exit', -1]])
    setCurrentRuntime(undefined)
  })
})
