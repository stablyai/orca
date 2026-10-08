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
const { listPreviousRelayPtyIds } = vi.hoisted(() => ({
  listPreviousRelayPtyIds: vi.fn(async (): Promise<string[] | null> => null)
}))
vi.mock('../ssh/ssh-legacy-relay-routing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPreviousRelayPtyIds
}))
vi.mock('../ssh/ssh-previous-relay-terminals', () => ({
  isReattachHeldByPreviousRelay: vi.fn(async () => true),
  startPreviousRelayCensus: vi.fn(),
  clearPreviousRelayCensus: vi.fn()
}))

import type { SshTarget } from '../../shared/ssh-types'
import { getSshPtyProvider, getPtyIdsForConnection } from './pty'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockPtyProvider } = mocks

describe('ssh:terminateSessions while an older relay may hold terminals', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore } = harness

  beforeEach(() => {
    harness.reset()
    listPreviousRelayPtyIds.mockReset().mockResolvedValue(null)
  })

  it('keeps a not-found terminal the previous relay may run and reports it unverifiable', async () => {
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
      { targetId: 'ssh-1', ptyId: 'pty-held', state: 'detached' }
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared IPC mock provider implements the shutdown this path calls.
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockRejectedValue(new Error('PTY "pty-held" not found'))

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 0, unverifiable: 1 })
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'ssh-1',
      'pty-held',
      'terminated'
    )
    // The final teardown must not bulk-mark the held lease terminated either.
    expect(mockStore.markSshRemotePtyLeasesAsync).not.toHaveBeenCalledWith('ssh-1', 'terminated')
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'detached')
  })

  // B4: a shell a respawn superseded on its tab still runs on the previous relay, leaseless.
  it('stops a shell only an older relay lists, through the provider that routes it there', async () => {
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    mockConnectionManager.connect.mockResolvedValue({})
    mockStore.getSshRemotePtyLeases.mockReturnValue([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared IPC mock provider implements the shutdown this path calls.
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    listPreviousRelayPtyIds.mockResolvedValue(['ssh:ssh-1@@pty2:old:1'])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toEqual({ terminated: 1, unverifiable: 0 })
    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty2:old:1', {
      immediate: true,
      keepHistory: false
    })
  })
})
