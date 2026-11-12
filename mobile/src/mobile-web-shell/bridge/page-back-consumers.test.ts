import { describe, expect, it, vi } from 'vitest'
import { createPageBackConsumers } from './page-back-consumers'

function consumers() {
  const claims: boolean[] = []
  const unclaimed = vi.fn()
  return {
    claims,
    unclaimed,
    stack: createPageBackConsumers({
      publishClaim: (claimed) => claims.push(claimed),
      onUnclaimed: unclaimed
    })
  }
}

describe('who in the page is holding the device Back key', () => {
  it('tells the shell on the edges only, so one sheet over another does not flicker the key', () => {
    const { claims, stack } = consumers()
    const first = stack.claim(() => true)
    const second = stack.claim(() => true)
    expect(claims).toEqual([true])
    second()
    expect(claims).toEqual([true])
    first()
    expect(claims).toEqual([true, false])
  })

  it('offers a press newest first, and stops at the one that takes it', () => {
    const { stack } = consumers()
    const order: string[] = []
    stack.claim(() => {
      order.push('bottom')
      return true
    })
    stack.claim(() => {
      order.push('top')
      return true
    })
    stack.press()
    expect(order).toEqual(['top'])
  })

  it('falls through a consumer that says the press was not its own', () => {
    const { stack, unclaimed } = consumers()
    const order: string[] = []
    stack.claim(() => {
      order.push('bottom')
      return true
    })
    stack.claim(() => {
      order.push('top')
      return false
    })
    stack.press()
    expect(order).toEqual(['top', 'bottom'])
    expect(unclaimed).not.toHaveBeenCalled()
  })

  // A claim can become stale while the press crosses; return unclaimed presses to native navigation instead of swallowing them.
  it('hands a press nothing took back to the shell rather than dropping it', () => {
    const { stack, unclaimed } = consumers()
    stack.press()
    expect(unclaimed).toHaveBeenCalledTimes(1)
    const release = stack.claim(() => false)
    stack.press()
    expect(unclaimed).toHaveBeenCalledTimes(2)
    release()
  })

  it('survives a consumer that disposes itself from inside its own answer', () => {
    const { stack } = consumers()
    const order: string[] = []
    stack.claim(() => {
      order.push('bottom')
      return true
    })
    const release = stack.claim(() => {
      order.push('top')
      release()
      return false
    })
    stack.press()
    // A copied stack must still visit the lower consumer after the upper one disposes itself.
    expect(order).toEqual(['top', 'bottom'])
  })

  it('ignores a release called twice, so a remounting claim cannot free another one', () => {
    const { claims, stack } = consumers()
    const release = stack.claim(() => true)
    release()
    const other = stack.claim(() => true)
    release()
    expect(claims).toEqual([true, false, true])
    other()
    expect(claims).toEqual([true, false, true, false])
  })

  // Every ready/init clears the host claim; reassert current page state even without a new consumer edge.
  it('says again what it is holding when the shell asks, without a second edge', () => {
    const { claims, stack } = consumers()
    stack.claim(() => true)
    stack.reassert()
    expect(claims).toEqual([true, true])
  })

  // Reassert only a held claim: ready already cleared it at the shell, so unclaimed documents need no redundant false frame.
  it('says nothing when it is holding nothing, because the shell already holds that', () => {
    const { claims, stack } = consumers()
    stack.reassert()
    const release = stack.claim(() => true)
    release()
    stack.reassert()
    expect(claims).toEqual([true, false])
  })

  it('gives the key back when the client closes, whoever was still holding it', () => {
    const { claims, stack } = consumers()
    stack.claim(() => true)
    stack.claim(() => true)
    stack.clear()
    expect(claims).toEqual([true, false])
    stack.clear()
    expect(claims).toEqual([true, false])
  })
})
