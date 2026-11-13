import { describe, expect, it, vi } from 'vitest'
import { beginTerminalHostSleepTermination } from '../terminal-host-sleep-termination'

const request = (onAccepted = vi.fn()) => ({
  id: 'pty',
  expectedIncarnationId: 'A',
  immediate: true,
  onAccepted
})

describe('a Sleep beginning its own termination', () => {
  // GH1267: a refused root signal clears isTerminating while its teardown is still tracked.
  it('refuses a session whose earlier teardown is still tracked, without joining it', () => {
    const kill = vi.fn(async () => {})
    const onAccepted = vi.fn()

    const termination = beginTerminalHostSleepTermination(request(onAccepted), {
      session: { incarnationId: 'A', isAlive: true, isTerminating: false },
      teardownTracked: () => true,
      kill
    })

    expect(termination).toEqual({ accepted: false, reason: 'terminating' })
    expect(kill).not.toHaveBeenCalled()
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('reserves its own termination once no teardown is tracked', () => {
    const onAccepted = vi.fn()
    const kill = vi.fn(async (_id: string, options: { onReservationAccepted: () => void }) => {
      options.onReservationAccepted()
    })

    const termination = beginTerminalHostSleepTermination(request(onAccepted), {
      session: { incarnationId: 'A', isAlive: true, isTerminating: false },
      teardownTracked: () => false,
      kill
    })

    expect(termination.accepted).toBe(true)
    expect(kill).toHaveBeenCalledOnce()
    expect(onAccepted).toHaveBeenCalledOnce()
  })
})
