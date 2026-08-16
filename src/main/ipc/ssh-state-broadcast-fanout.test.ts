import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
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

import { registerSshHandlers } from './ssh'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import type { SshPtyDataCallback } from '../providers/ssh-pty-provider-contract'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockAcceptSshPtyOutputData,
  mockAcceptSshPtyOutputExit,
  mockPtyProvider
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { ipcTestSource, handlers, mockStore, mockWindow } = harness

  beforeEach(harness.reset)

  it('forwards remote PTY events through the output intake authority', async () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
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

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    const onData = mockPtyProvider.onData.mock.calls[0]?.[0] as SshPtyDataCallback | undefined
    const onExit = mockPtyProvider.onExit.mock.calls[0]?.[0] as
      | ((payload: {
          id: string
          code: number
          providerGeneration: number
          ptyIncarnation: string
        }) => void)
      | undefined

    onData?.({
      id: 'remote-pty',
      data: 'hello',
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty',
      source: ipcTestSource
    })
    onExit?.({
      id: 'remote-pty',
      code: 7,
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty'
    })

    expect(mockAcceptSshPtyOutputData).toHaveBeenCalledWith({
      id: 'remote-pty',
      data: 'hello',
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty',
      rawLength: 'hello'.length,
      transformed: false,
      source: ipcTestSource
    })
    expect(mockAcceptSshPtyOutputExit).toHaveBeenCalledWith({
      id: 'remote-pty',
      code: 7,
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty'
    })
    expect(runtime.onPtyData).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
  })

  it('mirrors SSH state broadcasts onto the runtime client-event stream', async () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      notifySshStateChanged: vi.fn(),
      notifySshRelayReady: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
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

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    // Why: paired remote clients only learn SSH state through this hook —
    // without it their reconnect overlays never clear (STA-1468).
    expect(runtime.notifySshStateChanged).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({ targetId: 'ssh-1', status: 'connected' })
    )
    expect(runtime.notifySshRelayReady).toHaveBeenCalledWith('ssh-1')
  })

  it('keeps runtime-owned SSH state off the renderer while invalidating runtime scans', async () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      invalidateSshWorktreeScanCache: vi.fn(),
      notifySshStateChanged: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    mockSshStore.getTarget.mockReturnValue({
      id: 'runtime-ssh-1',
      label: 'Runtime host',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    } satisfies SshTarget)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'runtime-ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'runtime-ssh-1' })

    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.anything()
    )
    expect(runtime.invalidateSshWorktreeScanCache).toHaveBeenCalledWith('runtime-ssh-1')
    expect(runtime.notifySshStateChanged).not.toHaveBeenCalled()
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
