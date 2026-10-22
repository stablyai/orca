import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

import { createSystemSleepHoldReader } from '../macos-sleep-disabled-setting'
import { registerSystemSleepHoldHandler } from './system-sleep-hold-ipc'

const PMSET_YES = 'System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1\n'

function registeredHandler(): () => Promise<{ sleepDisabled: string }> {
  const call = handleMock.mock.calls.find(
    ([channel]) => channel === 'agentAwake:getSystemSleepHold'
  )
  if (!call) {
    throw new Error('system sleep hold handler was not registered')
  }
  return call[1]
}

describe('registerSystemSleepHoldHandler', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('serves the reader result', async () => {
    const hold = { sleepDisabled: 'yes', observedAt: 5 }
    registerSystemSleepHoldHandler({ read: vi.fn().mockResolvedValue(hold), dispose: vi.fn() })

    await expect(registeredHandler()()).resolves.toEqual(hold)
  })

  it('lets two windows share one pmset probe', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      signal: null,
      stdout: PMSET_YES,
      stderr: '',
      timedOut: false
    })
    const reader = createSystemSleepHoldReader({ run, platform: 'darwin' })
    registerSystemSleepHoldHandler(reader)

    const handler = registeredHandler()
    const [first, second] = await Promise.all([handler(), handler()])

    expect(first).toEqual(second)
    expect(first.sleepDisabled).toBe('yes')
    expect(run).toHaveBeenCalledTimes(1)
    reader.dispose()
  })
})
