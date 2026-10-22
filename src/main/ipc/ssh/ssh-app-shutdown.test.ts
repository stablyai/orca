import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)
const { shutdownTunnelsMock } = vi.hoisted(() => ({ shutdownTunnelsMock: vi.fn() }))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shutdownOrcadManagedTunnels: shutdownTunnelsMock
}))

import { beginSshShutdown } from './ssh-shutdown-drain'
import type { SshTarget } from '../../../shared/ssh-types'
import { quitTeardownStartGate } from '../../quit-teardown-start-gate'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockPortForwardManager } = mocks

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

  it('stops every port forward and managed tunnel process before quit finishes', async () => {
    mockConnectionManager.disconnectAll.mockResolvedValue(undefined)
    let finishForwards!: () => void
    mockPortForwardManager.closeAll.mockReturnValue(
      new Promise<void>((resolve) => {
        finishForwards = resolve
      })
    )
    shutdownTunnelsMock.mockResolvedValue(undefined)
    quitTeardownStartGate.tryStart({ preventDefault() {} })

    let finished = false
    const shutdown = beginSshShutdown().then(() => {
      finished = true
    })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
    expect(finished).toBe(false)
    expect(shutdownTunnelsMock).toHaveBeenCalled()
    finishForwards()
    await shutdown

    expect(mockPortForwardManager.closeAll).toHaveBeenCalled()
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
    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target, { probe: true })

    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const shutdown = beginSshShutdown()
    openProbeTransport()
    await shutdown

    expect(await probe).toMatchObject({ success: true })
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-probe')
  })
})
