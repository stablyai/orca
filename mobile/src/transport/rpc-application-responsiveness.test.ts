import { describe, expect, it, vi } from 'vitest'
import { RpcApplicationResponsiveness } from './rpc-application-responsiveness'

describe('RpcApplicationResponsiveness subscriptions', () => {
  it('notifies once on latch and once on recovery', () => {
    const responsiveness = new RpcApplicationResponsiveness()
    const listener = vi.fn()
    responsiveness.subscribe(listener)

    responsiveness.recordTimeout(100)
    expect(listener).toHaveBeenCalledTimes(1)
    responsiveness.recordTimeout(200)
    expect(listener).toHaveBeenCalledTimes(1)

    responsiveness.recordResponse('worktree.ps', 300)
    expect(listener).toHaveBeenCalledTimes(2)
    responsiveness.recordResponse('worktree.ps', 400)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('ignores control-probe responses and stops after unsubscribe', () => {
    const responsiveness = new RpcApplicationResponsiveness()
    const listener = vi.fn()
    const unsubscribe = responsiveness.subscribe(listener)

    responsiveness.recordResponse('status.get', 200)
    expect(listener).not.toHaveBeenCalled()
    expect(responsiveness.getUnresponsiveSince()).toBeNull()

    unsubscribe()
    responsiveness.recordTimeout(300)
    expect(listener).not.toHaveBeenCalled()
    expect(responsiveness.getUnresponsiveSince()).toBe(300)
  })

  it('does not treat relay resume confirmation as application recovery', () => {
    const responsiveness = new RpcApplicationResponsiveness()
    responsiveness.recordControlPlaneFailure(100)

    responsiveness.recordResponse('pairing.getEndpoints', 200)

    expect(responsiveness.getUnresponsiveSince()).toBe(100)
  })
})
