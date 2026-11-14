import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../../shared/computer-use-permissions-types'
import { createPermissionStatusGate } from './macos-computer-use-permission-status-gate'

const lockedGranted: ComputerUsePermissionStatusResult = {
  platform: 'darwin',
  helperAppPath: '/Applications/Orca Computer Use.app',
  helperUnavailableReason: null,
  permissions: [
    { id: 'accessibility', status: 'granted' },
    { id: 'screenshots', status: 'granted' }
  ],
  sessionLocked: true
}

describe('permission status gate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never replays a result read while the screen was locked', async () => {
    const probe = vi.fn(async () => lockedGranted)
    const gate = createPermissionStatusGate(probe)
    await gate.read()
    await vi.advanceTimersByTimeAsync(0)
    const next = gate.peek()
    await vi.advanceTimersByTimeAsync(5_000)
    await next
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
