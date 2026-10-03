import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../shared/terminal-stream-protocol'
import { TerminalStreamProgressReporter } from '../observability/terminal-stream-progress'
import {
  TERMINAL_SEND_PROGRESS_MAX_STREAMS,
  TerminalSubscriptionSendProgress
} from './terminal-subscription-send-progress'
import { forwardRuntimeSubscriptionBinary } from './runtime-subscription-binary-send'

function input(streamId = 5, opcode = TerminalStreamOpcode.Input): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode,
    streamId,
    seq: 0,
    payload: encodeTerminalStreamText('private command and credentials')
  })
}

function fixture() {
  const emit = vi.fn()
  const progress = new TerminalSubscriptionSendProgress(new TerminalStreamProgressReporter(emit))
  const subscription = {
    requestId: 'request-1',
    environmentId: 'environment-1',
    method: 'terminal.multiplex',
    ownerWebContentsId: 7,
    sendBinary: vi.fn<(bytes: Uint8Array<ArrayBufferLike>) => boolean>(() => true)
  }
  const subscriptions = new Map([['subscription-1', subscription]])
  const send = (bytes: unknown, owner = 7, subscriptionId = 'subscription-1') =>
    forwardRuntimeSubscriptionBinary(subscriptions, owner, { subscriptionId, bytes }, progress)
  return { emit, progress, subscription, subscriptions, send }
}

describe('runtime subscription binary send diagnostics', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('preserves forwarding and reports accepted/refused counts without payload', () => {
    const { emit, subscription, send } = fixture()
    const bytes = input()
    send(bytes)
    expect(subscription.sendBinary).toHaveBeenLastCalledWith(bytes)
    expect(vi.getTimerCount()).toBe(0)
    subscription.sendBinary.mockReturnValue(false)
    send(input(5, TerminalStreamOpcode.Ack))
    vi.advanceTimersByTime(1_000)
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      identity: { requestId: 'request-1', streamId: 5, side: 'client' },
      counters: { ipcInputAccepted: 1, ipcAckRefused: 1 },
      reasons: ['ipc_transport_refused']
    })
    expect(JSON.stringify(emit.mock.calls)).not.toContain('private command')
  })

  it('keeps missing subscriptions and ownership refusals separate', () => {
    const { emit, subscription, subscriptions, send } = fixture()
    send(input(), 9)
    subscriptions.clear()
    send(input())
    expect(subscription.sendBinary).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      identity: { requestId: 'request-1', streamId: 5 },
      counters: { ipcInputRefused: 2 },
      reasons: ['ipc_owner_mismatch', 'ipc_subscription_missing']
    })
  })

  it('preserves thrown send errors and binary view offsets', () => {
    const { subscription, send, emit } = fixture()
    const bytes = input()
    const padded = new Uint8Array(bytes.length + 8)
    padded.set(bytes, 4)
    const view = new DataView(padded.buffer, 4, bytes.length)
    send(view)
    expect(subscription.sendBinary.mock.calls[0]?.[0]).toEqual(bytes)
    subscription.sendBinary.mockImplementation(() => { throw new Error('transport') })
    expect(() => send(bytes)).toThrow('transport')
    expect(emit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not instrument another binary protocol or change invalid payload handling', () => {
    const { subscription, send, emit } = fixture()
    subscription.method = 'browser.screencast'
    subscription.sendBinary.mockReturnValue(false)
    send(input())
    send('not binary')
    expect(subscription.sendBinary).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(60_000)
    expect(emit).not.toHaveBeenCalled()
  })

  it('bounds retained streams and cancels an evicted stream report', () => {
    const { progress, send, emit } = fixture()
    send(input(0), 9)
    for (let streamId = 1; streamId <= TERMINAL_SEND_PROGRESS_MAX_STREAMS; streamId++) {
      send(input(streamId))
    }
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(emit).not.toHaveBeenCalled()
    progress.dispose()
  })

  it('does not mix request generations reusing a subscription and stream slot', () => {
    const { subscription, send, emit } = fixture()
    send(input(), 9)
    subscription.requestId = 'request-2'
    send(input())
    expect(vi.getTimerCount()).toBe(0)
    subscription.sendBinary.mockReturnValue(false)
    send(input())
    vi.advanceTimersByTime(1_000)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      identity: { requestId: 'request-2', streamId: 5 },
      counters: { ipcInputAccepted: 1, ipcInputRefused: 1 }
    })
  })
})
