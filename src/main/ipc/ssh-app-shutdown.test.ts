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

import { beginSshShutdown } from './ssh-shutdown-drain'
import type { SshTarget } from '../../shared/ssh-types'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness

  beforeEach(harness.reset)

  it('returns as soon as a fast shutdown drains rather than waiting out the budget', async () => {
    vi.useFakeTimers()
    try {
      mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)
      quitTeardownStartGate.tryStart({ preventDefault() {} })

      const result = await beginSshShutdown()

      expect(result.unfinished).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('joins an in-flight test-connection probe before the final shutdown disconnect', async () => {
    const target: SshTarget = {
      id: 'ssh-probe',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-probe',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockConnectionManager.disconnectAll.mockResolvedValue(undefined)
    mockConnectionManager.disconnect.mockClear().mockResolvedValue(undefined)

    // Why: a probe holds a transport no session owns, so shutdown has to wait for it to hand it back.
    const probeState = {
      targetId: 'ssh-probe',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    let openProbeTransport = (): void => {}
    mockConnectionManager.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          openProbeTransport = () => resolve({ getState: () => probeState })
        })
    )
    const probe = handlers.get('ssh:testConnection')!(null, { targetId: 'ssh-probe' })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)

    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const shutdown = beginSshShutdown()
    openProbeTransport()
    await shutdown

    expect(await probe).toMatchObject({ success: true })
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-probe')
  })
})
