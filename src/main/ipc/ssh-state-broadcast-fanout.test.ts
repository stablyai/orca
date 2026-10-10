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
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { registerSshHandlers } from './ssh'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { mockStore, mockWindow } = harness

  beforeEach(harness.reset)

  it('keeps claimed managed-orcad SSH state off clients under the original target id', () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      invalidateSshWorktreeScanCache: vi.fn(),
      notifySshStateChanged: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Managed orcad host',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      owner: { type: 'on-demand-runtime', runtimeId: 'managed-orcad:environment-1' }
    } satisfies SshTarget)
    const callbacks = mockConnectionManager.callbacksRef.current as {
      onStateChange: (targetId: string, state: SshConnectionState) => void
    }

    callbacks.onStateChange('ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    expect(runtime.invalidateSshWorktreeScanCache).toHaveBeenCalledWith('ssh-1')
    expect(runtime.notifySshStateChanged).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.anything()
    )
  })

  it('invalidates runtime scans from hidden SSH state broadcasts', () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      invalidateSshWorktreeScanCache: vi.fn(),
      notifySshStateChanged: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    const callbacks = mockConnectionManager.callbacksRef.current as {
      onStateChange: (targetId: string, state: SshConnectionState) => void
    }

    callbacks.onStateChange('runtime-ssh-1', {
      targetId: 'runtime-ssh-1',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 1
    })

    expect(runtime.invalidateSshWorktreeScanCache).toHaveBeenCalledWith('runtime-ssh-1')
    expect(runtime.notifySshStateChanged).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.anything()
    )
  })
})
