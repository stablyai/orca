import { describe, expect, it, vi } from 'vitest'
import { MobileWebSpeechSubscriptions } from './mobile-web-speech-subscriptions'

describe('MobileWebSpeechSubscriptions', () => {
  it('orders events and drops queued delivery after cancellation', async () => {
    let releaseFirst: (() => void) | undefined
    const postEvent = vi.fn((_subscriptionId: string, sequence: number) =>
      sequence === 0
        ? new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        : Promise.resolve()
    )
    const subscriptions = new MobileWebSpeechSubscriptions({
      isActive: () => true,
      postEvent,
      postClosed: vi.fn()
    })
    subscriptions.start({ requestId: 'request-1', subscriptionId: 'subscription-1' })

    subscriptions.post({ status: 'recording' })
    subscriptions.post({ status: 'processing' })
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    expect(subscriptions.cancel('subscription-1')).toBe('request-1')
    releaseFirst?.()

    await Promise.resolve()
    await Promise.resolve()
    expect(postEvent).toHaveBeenCalledOnce()
    expect(postEvent).toHaveBeenCalledWith('subscription-1', 0, { status: 'recording' })
  })

  it('tells the page when a delivery failure retires the dictation stream', async () => {
    const postClosed = vi.fn()
    const subscriptions = new MobileWebSpeechSubscriptions({
      isActive: () => true,
      postEvent: () => Promise.reject(new Error('post failed')),
      postClosed
    })
    subscriptions.start({ requestId: 'request-1', subscriptionId: 'subscription-1' })

    subscriptions.post({ status: 'recording' })
    await vi.waitFor(() => expect(postClosed).toHaveBeenCalledOnce())

    expect(postClosed).toHaveBeenCalledWith('subscription-1', {
      code: 'unavailable',
      retryable: true
    })
    expect(subscriptions.cancel('subscription-1')).toBeNull()
  })

  it('refuses a new dictation stream once the ledger is disposed', () => {
    const subscriptions = new MobileWebSpeechSubscriptions({
      isActive: () => true,
      postEvent: async () => {},
      postClosed: vi.fn()
    })
    subscriptions.dispose()

    expect(() =>
      subscriptions.start({ requestId: 'request-1', subscriptionId: 'subscription-1' })
    ).toThrow('invalid_request')
  })
})
