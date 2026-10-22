import { afterEach, expect, it, vi } from 'vitest'

const { health, spawn } = vi.hoisted(() => ({ health: vi.fn(), spawn: vi.fn() }))
vi.mock('./daemon-async-io-probe', () => ({ checkDaemonAsyncIo: health }))
vi.mock('node-pty', () => ({ spawn }))

import { runPtySpawnHealthProbe } from './pty-subprocess/spawn-preflight'
import { DaemonHealthRequests } from './daemon-health-requests'

afterEach(() => vi.clearAllMocks())

it('does not certify terminal health from a native spawn when asynchronous I/O is stalled', async () => {
  health.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  await expect(runPtySpawnHealthProbe()).rejects.toThrow('asynchronous I/O is stalled')
  expect(spawn).not.toHaveBeenCalled()
})

it('reports asynchronous progress and logs only transitions into and out of a stall', async () => {
  const log = vi.fn()
  const handler = new DaemonHealthRequests(vi.fn(), { log })
  const request = { id: 'health', type: 'asyncIoHealth' } as const
  health.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  expect(await handler.handle(request)).toEqual({ state: 'healthy', pendingMs: 0 })
  expect(log).not.toHaveBeenCalled()
  health.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  expect(await handler.handle(request)).toEqual({ state: 'stalled', pendingMs: 5000 })
  await handler.handle(request)
  health.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  await handler.handle(request)
  expect(log.mock.calls).toEqual([
    ['async-io-stalled', { pendingMs: 5000 }],
    ['async-io-recovered', { pendingMs: 0 }]
  ])
})
