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

import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import {
  RelayRuntimeLadderRun,
  RemoteRuntimeUnavailableError
} from '../ssh/ssh-relay-runtime-resolution'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockDeployAndLaunchRelay } = mocks

function noexecHome(): RemoteRuntimeUnavailableError {
  const run = new RelayRuntimeLadderRun('ssh-1', null)
  run.refused('A', 'noexec')
  return new RemoteRuntimeUnavailableError('home_noexec', run)
}

function connectedStates(send: ReturnType<typeof vi.fn>): SshConnectionState[] {
  return (
    send.mock.calls
      .filter(([channel]) => channel === 'ssh:state-changed')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh:state-changed always carries { targetId, state }.
      .map(([, payload]) => (payload as { state: SshConnectionState }).state)
      .filter((state) => state.status === 'connected')
  )
}

describe('ssh:connect when no Orca runtime can run on the host', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow } = harness

  beforeEach(harness.reset)

  it('connects in plain SSH mode, publishes the reason, and keeps it across a refresh', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = { usesSystemSshTransport: () => false, shell: vi.fn(), sftp: vi.fn() }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockDeployAndLaunchRelay.mockRejectedValue(noexecHome())

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    const [connected] = connectedStates(mockWindow.webContents.send)
    expect(connected?.plainSsh).toEqual({
      reason: 'home_noexec',
      message: expect.stringContaining('the home directory is mounted noexec')
    })

    // A window reactivation re-fires ssh:connect; it must not redeploy and kill the plain shells.
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    expect(mockDeployAndLaunchRelay).toHaveBeenCalledTimes(1)
  })
})
