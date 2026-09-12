import { expect, it, vi } from 'vitest'
import { DaemonRouterRetirement } from './daemon-router-retirement'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { PROTOCOL_VERSION } from './types'

it.each(['inventory', 'protocol', 'spawn', 'live'] as const)(
  'does not reopen admission on a %s retry after partial retirement',
  async (failure) => {
    const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
    const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
    let adapters = [current, legacy]
    const retirement = new DaemonRouterRetirement(() => adapters)
    vi.mocked(legacy.requestIdleRetirement).mockResolvedValueOnce({
      state: 'busy',
      liveSessions: 0
    })
    await expect(retirement.requestIdleRetirement()).resolves.toEqual({ state: 'unverifiable' })
    expect(retirement.admissionClosed).toBe(true)
    if (failure === 'inventory') {
      vi.mocked(current.listSessions).mockRejectedValueOnce(new Error('lost connection'))
    } else if (failure === 'protocol') {
      adapters = [createAdapter('old', [], undefined, 23)]
    } else if (failure === 'spawn') {
      retirement.spawnInFlight = 1
    } else {
      adapters = [createAdapter('live', ['existing'], undefined, PROTOCOL_VERSION)]
    }
    expect(await retirement.requestIdleRetirement()).not.toHaveProperty('admissionReopened')
    expect(retirement.admissionClosed).toBe(true)
  }
)

it('does not reopen when every native result is busy without reopening proof', async () => {
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  vi.mocked(current.requestIdleRetirement).mockResolvedValue({ state: 'busy', liveSessions: 0 })
  const retirement = new DaemonRouterRetirement(() => [current])
  await expect(retirement.requestIdleRetirement()).resolves.toEqual({ state: 'unverifiable' })
  expect(retirement.admissionClosed).toBe(true)
})

it('keeps the fence through a lost native reply and failed retry inventory', async () => {
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  vi.mocked(current.requestIdleRetirement).mockRejectedValueOnce(new Error('lost stop reply'))
  const retirement = new DaemonRouterRetirement(() => [current])
  await expect(retirement.requestIdleRetirement()).rejects.toThrow('lost stop reply')
  vi.mocked(current.listSessions).mockRejectedValueOnce(new Error('lost connection'))
  await expect(retirement.requestIdleRetirement()).resolves.toEqual({ state: 'unverifiable' })
  expect(retirement.admissionClosed).toBe(true)
})
