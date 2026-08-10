import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resolveEnvironmentMock,
  subscribeRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeSharedControlRequestMock,
  supportsSharedControlMock
} = vi.hoisted(() => ({
  resolveEnvironmentMock: vi.fn(),
  subscribeRemoteRuntimeRequestMock: vi.fn(),
  subscribeRemoteRuntimeSharedControlRequestMock: vi.fn(),
  supportsSharedControlMock: vi.fn()
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  markEnvironmentUsed: vi.fn(),
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: vi.fn(),
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', () => ({
  getRemoteRuntimeSharedControlDiagnostics: vi.fn(() => null),
  reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
  sendRemoteRuntimeConnectionRequest: vi.fn(),
  sendRemoteRuntimeSharedControlRequest: vi.fn(),
  subscribeRemoteRuntimeSharedControlRequest: subscribeRemoteRuntimeSharedControlRequestMock
}))

vi.mock('./runtime-environment-shared-control-support', () => ({
  clearSharedControlSupport: vi.fn(),
  resetSharedControlSupport: vi.fn(),
  supportsSharedControl: supportsSharedControlMock
}))

import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

const callbacks = {
  onEvent: vi.fn(),
  onClose: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveEnvironmentMock.mockReturnValue({
    id: 'environment-a',
    name: 'desk',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: 'primary',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'device-token',
        publicKeyB64: 'public-key'
      }
    ]
  })
})

describe('runtime environment subscription cancellation', () => {
  it('rejects pre-aborted setup without probing or opening a subscription', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      subscribeRuntimeEnvironment(
        '/user-data',
        'environment-a',
        'files.watch',
        {},
        1000,
        callbacks,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(supportsSharedControlMock).not.toHaveBeenCalled()
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()
    expect(subscribeRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('stops after a pending shared-control probe is aborted', async () => {
    const controller = new AbortController()
    let resolveSupport: (supported: boolean) => void = () => {}
    supportsSharedControlMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSupport = resolve
        })
    )
    const setup = subscribeRuntimeEnvironment(
      '/user-data',
      'environment-a',
      'files.watch',
      {},
      1000,
      callbacks,
      controller.signal
    )

    await vi.waitFor(() => expect(supportsSharedControlMock).toHaveBeenCalled())
    controller.abort()
    resolveSupport(true)

    await expect(setup).rejects.toMatchObject({ name: 'AbortError' })
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()
    expect(subscribeRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('closes shared-control setup that resolves after cancellation', async () => {
    const controller = new AbortController()
    const close = vi.fn()
    supportsSharedControlMock.mockResolvedValue(true)
    subscribeRemoteRuntimeSharedControlRequestMock.mockImplementation(async () => {
      controller.abort()
      return { requestId: 'shared-request', close, sendBinary: vi.fn() }
    })

    await expect(
      subscribeRuntimeEnvironment(
        '/user-data',
        'environment-a',
        'files.watch',
        {},
        1000,
        callbacks,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('passes cancellation to a dedicated socket and closes a late result', async () => {
    const controller = new AbortController()
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementation(async () => {
      controller.abort()
      return { requestId: 'dedicated-request', close, sendBinary: vi.fn() }
    })

    await expect(
      subscribeRuntimeEnvironment(
        '/user-data',
        'environment-a',
        'terminal.multiplex',
        {},
        1000,
        callbacks,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'terminal.multiplex',
      {},
      1000,
      expect.any(Object),
      undefined,
      controller.signal
    )
    expect(close).toHaveBeenCalledTimes(1)
  })
})
