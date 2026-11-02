import { afterEach, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'

afterEach(() => vi.restoreAllMocks())

it.each([
  [
    { state: 'healthy', pendingMs: 0 },
    { state: 'healthy', pendingMs: 0 }
  ],
  [
    { state: 'stalled', pendingMs: 5000 },
    { state: 'stalled', pendingMs: 5000 }
  ],
  [{ state: 'stalled', pendingMs: -1 }, { state: 'unverifiable' }],
  [{ state: 'stalled', pendingMs: Infinity }, { state: 'unverifiable' }],
  [null, { state: 'unverifiable' }]
])('validates daemon progress evidence: %j', async (response, expected) => {
  vi.spyOn(DaemonClient.prototype, 'isConnected').mockReturnValue(true)
  const request = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue(response)
  const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
  expect(await adapter.getAsyncIoHealth()).toEqual(expected)
  expect(request).toHaveBeenCalledExactlyOnceWith('asyncIoHealth', undefined, 7_000)
})

it.each([
  ['Unknown request type: asyncIoHealth', 'unsupported'],
  ['Request timed out', 'unverifiable'],
  ['Connection lost', 'unverifiable']
])('does not diagnose an old or unreachable daemon as stalled: %s', async (message, state) => {
  vi.spyOn(DaemonClient.prototype, 'isConnected').mockReturnValue(true)
  vi.spyOn(DaemonClient.prototype, 'request').mockRejectedValue(new Error(message))
  const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
  expect(await adapter.getAsyncIoHealth()).toEqual({ state })
})

it('never reconnects or restarts a daemon to read health', async () => {
  const request = vi.spyOn(DaemonClient.prototype, 'request')
  const connect = vi.spyOn(DaemonClient.prototype, 'ensureConnected')
  const adapter = new DaemonPtyAdapter({ socketPath: '/unused', tokenPath: '/unused' })
  expect(await adapter.getAsyncIoHealth()).toEqual({ state: 'unverifiable' })
  expect(request).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})
