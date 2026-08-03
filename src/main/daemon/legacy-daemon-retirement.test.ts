import { beforeEach, describe, expect, it, vi } from 'vitest'
import { retireLegacyDaemonIfIdle } from './legacy-daemon-retirement'

const { daemonClientMock, getDaemonSocketPathMock, getDaemonTokenPathMock } = vi.hoisted(() => ({
  daemonClientMock: vi.fn(),
  getDaemonSocketPathMock: vi.fn(
    (runtimeDir: string, protocolVersion: number) => `${runtimeDir}/v${protocolVersion}.sock`
  ),
  getDaemonTokenPathMock: vi.fn(
    (runtimeDir: string, protocolVersion: number) => `${runtimeDir}/v${protocolVersion}.token`
  )
}))

vi.mock('./client', () => ({ DaemonClient: daemonClientMock }))
vi.mock('./daemon-spawner', () => ({
  getDaemonSocketPath: getDaemonSocketPathMock,
  getDaemonTokenPath: getDaemonTokenPathMock
}))

function mockClient(result: unknown, connectionError?: Error) {
  const client = {
    ensureConnectedWithin: vi.fn(async () => {
      if (connectionError) {
        throw connectionError
      }
    }),
    request: vi.fn(async () => result),
    disconnect: vi.fn()
  }
  daemonClientMock.mockImplementation(function MockDaemonClient() {
    return client
  })
  return client
}

describe('legacy daemon idle retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bypasses protocol v23 without creating a client', async () => {
    await expect(retireLegacyDaemonIfIdle('/runtime', 23)).resolves.toBe(false)

    expect(daemonClientMock).not.toHaveBeenCalled()
  })

  it('starts at protocol v24 and returns the authenticated daemon decision', async () => {
    const client = mockClient({ retiring: true })

    await expect(retireLegacyDaemonIfIdle('/runtime', 24)).resolves.toBe(true)

    expect(daemonClientMock).toHaveBeenCalledWith({
      socketPath: '/runtime/v24.sock',
      tokenPath: '/runtime/v24.token',
      protocolVersion: 24
    })
    expect(client.ensureConnectedWithin).toHaveBeenCalledWith(expect.any(Number))
    expect(client.request).toHaveBeenCalledWith('shutdownIfIdle', undefined, expect.any(Number))
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('preserves a daemon when it refuses retirement or returns a malformed result', async () => {
    const refusingClient = mockClient({ retiring: false })
    await expect(retireLegacyDaemonIfIdle('/runtime', 29)).resolves.toBe(false)
    expect(refusingClient.disconnect).toHaveBeenCalledOnce()

    const malformedClient = mockClient({})
    await expect(retireLegacyDaemonIfIdle('/runtime', 30)).resolves.toBe(false)
    expect(malformedClient.disconnect).toHaveBeenCalledOnce()
  })

  it('preserves a daemon when bounded authentication or retirement fails', async () => {
    const authenticationClient = mockClient(undefined, new Error('timed out'))

    await expect(retireLegacyDaemonIfIdle('/runtime', 30)).resolves.toBe(false)

    expect(authenticationClient.request).not.toHaveBeenCalled()
    expect(authenticationClient.disconnect).toHaveBeenCalledOnce()

    const requestClient = mockClient(undefined)
    requestClient.request.mockRejectedValueOnce(new Error('timed out'))
    await expect(retireLegacyDaemonIfIdle('/runtime', 30)).resolves.toBe(false)

    expect(requestClient.disconnect).toHaveBeenCalledOnce()
  })
})
