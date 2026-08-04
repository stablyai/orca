import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestMobileNativeChatStopLease,
  requestMobileNativeChatWriteLease,
  resetMobileNativeChatStopLeasesForTests
} from './mobile-native-chat-stop-lease'

describe('mobile native-chat terminal leases', () => {
  afterEach(resetMobileNativeChatStopLeasesForTests)

  it('runs Stop after the active action and before queued FIFO writers', async () => {
    const active = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const firstQueued = requestMobileNativeChatWriteLease('terminal-1')
    const secondQueued = requestMobileNativeChatWriteLease('terminal-1')
    const stop = requestMobileNativeChatStopLease('terminal-1')
    const order: string[] = []
    void firstQueued.acquired.then(() => order.push('first'))
    void secondQueued.acquired.then(() => order.push('second'))
    void stop?.acquired.then(() => order.push('stop'))

    active?.release()
    const stopLease = await stop?.acquired
    expect(order).toEqual(['stop'])

    stopLease?.release()
    const firstLease = await firstQueued.acquired
    expect(order).toEqual(['stop', 'first'])

    firstLease?.release()
    const secondLease = await secondQueued.acquired
    expect(order).toEqual(['stop', 'first', 'second'])
    secondLease?.release()
  })

  it('admits only one pending or active Stop per terminal', async () => {
    const writer = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const stop = requestMobileNativeChatStopLease('terminal-1')

    expect(stop).not.toBeNull()
    expect(requestMobileNativeChatStopLease('terminal-1')).toBeNull()
    writer?.release()
    const stopLease = await stop?.acquired
    expect(requestMobileNativeChatStopLease('terminal-1')).toBeNull()
    stopLease?.release()
  })

  it('scopes ownership per terminal', async () => {
    const first = await requestMobileNativeChatWriteLease('terminal-1').acquired

    await expect(requestMobileNativeChatWriteLease('terminal-2').acquired).resolves.toMatchObject({
      terminal: 'terminal-2'
    })
    first?.release()
  })

  it('does not let a stale release retire a successor', async () => {
    const first = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const successorRequest = requestMobileNativeChatWriteLease('terminal-1')
    first?.release()
    const successor = await successorRequest.acquired
    const later = requestMobileNativeChatWriteLease('terminal-1')
    const admitted = vi.fn()
    void later.acquired.then(admitted)

    first?.release()
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()

    successor?.release()
    await later.acquired
    expect(admitted).toHaveBeenCalledOnce()
  })

  it('cancels a queued writer without starving its successor', async () => {
    const active = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const canceled = requestMobileNativeChatWriteLease('terminal-1')
    const successor = requestMobileNativeChatWriteLease('terminal-1')

    canceled.cancel()
    await expect(canceled.acquired).resolves.toBeNull()
    active?.release()
    await expect(successor.acquired).resolves.toMatchObject({ terminal: 'terminal-1' })
  })
})
