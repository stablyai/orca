import { afterEach, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'

afterEach(() => vi.restoreAllMocks())

it.each([
  [{ status: 'granted' }, 'granted'],
  [{ status: 'denied' }, 'denied'],
  [{ status: 'future-status' }, 'unknown'],
  [null, 'unknown']
])('checks the owning connection and validates %j', async (response, expected) => {
  vi.spyOn(DaemonClient.prototype, 'isConnected').mockReturnValue(true)
  const request = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue(response)
  const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
  expect(await adapter.getFullDiskAccessStatus()).toBe(expected)
  expect(request).toHaveBeenCalledWith('fullDiskAccessStatus', undefined, 3000)
})

it.each(['Unknown request type', 'Request timed out', 'Connection lost'])(
  'keeps old or unreachable hosts unknown: %s',
  async (message) => {
    vi.spyOn(DaemonClient.prototype, 'isConnected').mockReturnValue(true)
    vi.spyOn(DaemonClient.prototype, 'request').mockRejectedValue(new Error(message))
    const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
    expect(await adapter.getFullDiskAccessStatus()).toBe('unknown')
  }
)

it('does not reconnect or respawn a disconnected host to obtain a verdict', async () => {
  const request = vi.spyOn(DaemonClient.prototype, 'request')
  const connect = vi.spyOn(DaemonClient.prototype, 'ensureConnected')
  const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
  expect(await adapter.getFullDiskAccessStatus()).toBe('unknown')
  expect(request).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})
