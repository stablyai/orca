import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const METHOD = 'future.feed.subscribe'
function fixture() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  authority.synchronize(['host-workspace'])
  const postEvent = vi.fn().mockResolvedValue(undefined)
  const postClosed = vi.fn()
  const unsubscribe = vi.fn()
  let emit: (event: unknown) => void = () => {}
  const sendRequest = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return unsubscribe
  })
  const ledger = new MobileWebHostSubscriptions({
    workspaceAuthority: authority,
    isActive: () => true,
    postEvent,
    postClosed
  })
  const args = {
    requestId: 'request',
    subscriptionId: 'stream',
    isActive: () => true,
    client: { sendRequest, subscribe } as unknown as RpcClient,
    payload: {
      method: METHOD,
      workspaceId: authority.pageWorkspaceId('host-workspace'),
      params: {}
    }
  }
  return {
    ledger,
    args,
    authority,
    sendRequest,
    subscribe,
    unsubscribe,
    postEvent,
    postClosed,
    emit: (event: unknown) => emit(event)
  }
}

describe('generic host subscriptions', () => {
  it('forwards future events and derives the desktop cancel name', async () => {
    const f = fixture()
    f.ledger.start(f.args)
    expect(f.subscribe).toHaveBeenCalledWith(
      METHOD,
      { worktree: 'id:host-workspace' },
      expect.any(Function),
      { serverUnsubscribeMethod: 'future.feed.unsubscribe' }
    )
    const event = { type: 'future-shape', nested: { additional: true } }
    f.emit(event)
    await vi.waitFor(() => expect(f.postEvent).toHaveBeenCalledWith('stream', 0, event))
    f.ledger.cancel('stream')
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not open a stream the page already cancelled', () => {
    const f = fixture()
    f.args.isActive = () => false
    expect(() => f.ledger.start(f.args)).toThrowError(
      expect.objectContaining({ code: 'cancelled' })
    )
    expect(f.subscribe).not.toHaveBeenCalled()
  })

  it('retires a late host handle after a synchronous oversized event', async () => {
    const f = fixture()
    f.subscribe.mockImplementationOnce((_method, _params, emit) => {
      emit({ payload: 'x'.repeat(600 * 1024) })
      return f.unsubscribe
    })
    f.ledger.start(f.args)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.postClosed).toHaveBeenCalledWith('stream', { code: 'too_large', retryable: false })
  })

  it('bounds retained event bytes while the page is stalled', async () => {
    const f = fixture()
    let release!: () => void
    f.postEvent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    f.ledger.start(f.args)
    f.emit({ payload: 'x'.repeat(400 * 1024) })
    await vi.waitFor(() => expect(f.postEvent).toHaveBeenCalledOnce())
    for (let index = 0; index < 6; index++) {
      f.emit({ payload: 'x'.repeat(400 * 1024) })
    }
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.postClosed).toHaveBeenCalledWith('stream', { code: 'rate_limited', retryable: true })
    release()
  })

  it('does not publish after workspace authority is retired', async () => {
    const f = fixture()
    f.ledger.start(f.args)
    f.authority.clear()
    f.emit({ type: 'future' })
    expect(f.postEvent).not.toHaveBeenCalled()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it('bounds tiny queued events while the page is stalled', async () => {
    const f = fixture()
    const stalled = Promise.withResolvers<void>()
    f.postEvent.mockReturnValueOnce(stalled.promise)
    f.ledger.start(f.args)
    f.emit({ value: 0 })
    await vi.waitFor(() => expect(f.postEvent).toHaveBeenCalledOnce())
    for (let value = 1; value <= 64; value++) {
      f.emit({ value })
    }
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.postClosed).toHaveBeenCalledWith('stream', { code: 'rate_limited', retryable: true })
    stalled.resolve()
  })

  it.each(['future.feed.read', 'future.files.unwatch'])(
    'refuses %s in the streaming lane, which has no cancel name to derive',
    (method) => {
      const f = fixture()
      f.args.payload = { ...f.args.payload, method }
      expect(() => f.ledger.start(f.args)).toThrowError(
        expect.objectContaining({ code: 'unsupported_capability' })
      )
      expect(f.subscribe).not.toHaveBeenCalled()
    }
  )
})
