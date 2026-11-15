import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  publishSystemResume,
  publishSystemSuspend,
  subscribeSystemPowerLifecycle
} from './system-power-lifecycle'

afterEach(() => {
  publishSystemResume()
  vi.restoreAllMocks()
})

describe('system power lifecycle', () => {
  it('replays suspended state to a late subscriber', () => {
    publishSystemSuspend()
    const listener = { onSuspend: vi.fn(), onResume: vi.fn() }
    const unsubscribe = subscribeSystemPowerLifecycle(listener)

    expect(listener.onSuspend).toHaveBeenCalledOnce()
    expect(listener.onResume).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('atomically replays a transition to a subscriber added during publication', () => {
    const lateListener = { onSuspend: vi.fn(), onResume: vi.fn() }
    let unsubscribeLate: (() => void) | undefined
    const unsubscribeFirst = subscribeSystemPowerLifecycle({
      onSuspend: () => {
        unsubscribeLate = subscribeSystemPowerLifecycle(lateListener)
      },
      onResume: vi.fn()
    })

    publishSystemSuspend()

    expect(lateListener.onSuspend).toHaveBeenCalledOnce()
    unsubscribeLate?.()
    unsubscribeFirst()
  })

  it('isolates a failing listener from the remaining subscribers', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsubscribeFailing = subscribeSystemPowerLifecycle({
      onSuspend: () => {
        throw new Error('listener failed')
      },
      onResume: vi.fn()
    })
    const healthyListener = { onSuspend: vi.fn(), onResume: vi.fn() }
    const unsubscribeHealthy = subscribeSystemPowerLifecycle(healthyListener)

    publishSystemSuspend()

    expect(healthyListener.onSuspend).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledOnce()
    unsubscribeHealthy()
    unsubscribeFailing()
  })
})
