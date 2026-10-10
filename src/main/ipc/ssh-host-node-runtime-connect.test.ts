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
import { recordSshRelayRuntimeStep } from '../ssh/ssh-host-node-runtime-mode'
import { setSshHostServerStatus, clearSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { getPublicSshState } from './ssh-renderer-broadcast'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockDeployAndLaunchRelay } = mocks

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remoteRuntime: 'legacy'
}

function lastConnectedState(send: ReturnType<typeof vi.fn>): SshConnectionState | undefined {
  return (
    send.mock.calls
      .filter(([channel]) => channel === 'ssh:state-changed')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh:state-changed always carries { targetId, state }.
      .map(([, payload]) => (payload as { state: SshConnectionState }).state)
      .findLast((state) => state.status === 'connected')
  )
}

describe('ssh:connect on the opt-in Host Node runtime', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow } = harness

  beforeEach(async () => {
    await harness.reset()
    recordSshRelayRuntimeStep('ssh-1', false)
    clearSshHostServerStatus('ssh-1')
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
  })

  it('publishes the connection as running the unsupported Host Node runtime', async () => {
    mockDeployAndLaunchRelay.mockImplementationOnce(async () => {
      recordSshRelayRuntimeStep('ssh-1', true)
      return harness.createRelayLaunchResult()
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    expect(lastConnectedState(mockWindow.webContents.send)?.hostNodeRuntime).toBe(true)
  })

  it('stays quiet on a ladder connect and once the host moved to its managed server', async () => {
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    expect(lastConnectedState(mockWindow.webContents.send)).not.toHaveProperty('hostNodeRuntime')

    recordSshRelayRuntimeStep('ssh-1', true)
    setSshHostServerStatus('ssh-1', {
      kind: 'managed',
      environmentId: 'env-1'
    })
    expect(getPublicSshState('ssh-1')).not.toHaveProperty('hostNodeRuntime')
  })
})
