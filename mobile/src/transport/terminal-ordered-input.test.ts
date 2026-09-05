import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalOrderedInput, advertiseTerminalOrderedInput } from './terminal-ordered-input'
import { decodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import { TERMINAL_ORDERED_INPUT_CAPABILITY as limits } from '../../../src/shared/terminal-ordered-input'

function setup(overrides = {}) {
  const binary = vi.fn((_bytes: Uint8Array) => true)
  const input = new TerminalOrderedInput(binary)
  input.register(
    'request',
    advertiseTerminalOrderedInput('terminal.subscribe', { terminal: 't' }),
    { type: 'subscribed', streamId: 8, capabilities: { orderedInput: { ...limits, ...overrides } } }
  )
  const receipt = (sequence: number, outcome: string) =>
    input.handle(8, { type: 'metadata', inputReceipt: { sequence, outcome } })
  return { input, binary, receipt }
}
afterEach(() => vi.useRealTimers())

describe('negotiated terminal input receipts', () => {
  it.each([
    [1, 'rejected'],
    [2, 'unknown']
  ] as const)('classifies refusal of pending sequence %s as %s', async (sequence, outcome) => {
    const { input, receipt } = setup()
    const first = input.send('t', 'a')!
    const second = input.send('t', 'b')!
    receipt(sequence, 'rejected')
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(input.failure('t')?.outcome).toBe(outcome)
    expect(input.recover('t')).toBe(false)
  })
  it('does not recover using a subscription registered before the failed admission', async () => {
    const { input, receipt } = setup()
    const params = advertiseTerminalOrderedInput('terminal.subscribe', { terminal: 't' })
    input.register('candidate', params, {
      type: 'subscribed',
      streamId: 9,
      capabilities: { orderedInput: limits }
    })
    const pending = input.send('t', 'x')!
    input.handle(9, { type: 'metadata', inputReceipt: { sequence: 1, outcome: 'unknown' } })
    expect(await pending).toBe(false)
    expect(input.recover('t')).toBe(false)
    receipt(1, 'accepted')
    expect(input.failure('t')?.outcome).toBe('unknown')
  })
  it('releases clean terminal records across 2048 subscribe/unsubscribe cycles', async () => {
    const input = new TerminalOrderedInput(() => true)
    for (let i = 1; i <= 2048; i += 1) {
      const terminal = `t-${i}`
      const request = `request-${i}`
      input.register(request, advertiseTerminalOrderedInput('terminal.subscribe', { terminal }), {
        type: 'subscribed',
        streamId: i,
        capabilities: { orderedInput: limits }
      })
      if (i % 2 === 0) {
        const accepted = input.send(terminal, 'a')!
        input.handle(i, { type: 'metadata', inputReceipt: { sequence: 1, outcome: 'accepted' } })
        expect(await accepted).toBe(true)
      }
      if (i % 3 === 0) {
        input.clear()
      } else {
        input.reset(request)
      }
      expect(input.supports(terminal)).toBe(false)
    }
    const retained = input as unknown as {
      streams: Map<string, unknown>
      byTerminal: Map<string, unknown>
    }
    expect(retained.streams.size).toBe(0)
    expect(retained.byTerminal.size).toBe(0)
  })
  it('waits for accepted receipts and sequences input independently of output metadata', async () => {
    const { input, binary, receipt } = setup()
    let settled = false
    const first = input.send('t', '한')!
    void first.then(() => {
      settled = true
    })
    const second = input.send('t', '\r')!
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(binary.mock.calls.map(([bytes]) => decodeTerminalStreamFrame(bytes))).toMatchObject([
      { opcode: TerminalStreamOpcode.Input, streamId: 8, seq: 1 },
      { opcode: TerminalStreamOpcode.Input, streamId: 8, seq: 2 }
    ])
    input.handle(8, { type: 'metadata', seq: 200 })
    expect(settled).toBe(false)
    receipt(1, 'accepted')
    receipt(2, 'accepted')
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  it.each(['rejected', 'unknown'])('latches %s without replay or later sends', async (outcome) => {
    const { input, binary, receipt } = setup()
    const first = input.send('t', 'text')!
    const second = input.send('t', '\r')!
    receipt(1, outcome)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(await input.send('t', 'later')).toBe(false)
    expect(input.supports('t')).toBe(true)
    expect(binary).toHaveBeenCalledTimes(2)
  })

  it.each([{ maxPendingFrames: 1 }, { maxPendingBytes: 1 }])(
    'bounds admitted outstanding input %j',
    async (limit) => {
      const { input, binary } = setup(limit)
      const first = input.send('t', 'a')!
      expect(await input.send('t', 'b')).toBe(false)
      expect(await first).toBe(false)
      expect(binary).toHaveBeenCalledTimes(1)
    }
  )

  it('checks UTF-8 frame bytes and latches local refusal', async () => {
    const { input, binary } = setup({ maxFrameBytes: 2 })
    expect(await input.send('t', '한')).toBe(false)
    expect(await input.send('t', 'a')).toBe(false)
    expect(binary).not.toHaveBeenCalled()
  })

  it('settles and releases receipts on unsubscribe and ignores old receipts', async () => {
    const { input, receipt } = setup()
    const first = input.send('t', 'a')!
    input.reset('request')
    expect(await first).toBe(false)
    receipt(1, 'accepted')
    expect(await input.send('t', 'b')).toBe(false)
    expect(input.supports('t')).toBe(true)
  })

  it('times out missing receipts without permitting further input', async () => {
    vi.useFakeTimers()
    const { input, binary } = setup()
    const first = input.send('t', 'a')!
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await first).toBe(false)
    expect(await input.send('t', 'b')).toBe(false)
    expect(binary).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns fallback only when no compatible host echo exists', () => {
    const input = new TerminalOrderedInput(vi.fn())
    const params = advertiseTerminalOrderedInput('terminal.subscribe', { terminal: 't' })
    input.register('old', params, { type: 'subscribed', streamId: 1 })
    expect(input.send('t', 'a')).toBe(null)
    expect(input.supports('t')).toBe(false)
    input.register('future', params, {
      type: 'subscribed',
      streamId: 2,
      capabilities: { orderedInput: { ...limits, version: 2 } }
    })
    expect(input.send('t', 'a')).toBe(null)
  })

  it('keeps uncertainty latched across an old-host reconnect and recovers only after fresh negotiation', async () => {
    const { input, receipt } = setup()
    const first = input.send('t', 'prefix')!
    input.clear()
    expect(await first).toBe(false)
    const params = advertiseTerminalOrderedInput('terminal.subscribe', { terminal: 't' })
    input.register('old', params, { type: 'subscribed', streamId: 9 })
    expect(input.recover('t')).toBe(false)
    expect(input.supports('t')).toBe(true)
    expect(await input.send('t', '\r')).toBe(false)
    input.register('fresh', params, {
      type: 'subscribed',
      streamId: 10,
      capabilities: { orderedInput: limits }
    })
    expect(await input.send('t', 'blocked')).toBe(false)
    expect(input.recover('t')).toBe(true)
    const fresh = input.send('t', 'fresh')!
    receipt(1, 'accepted')
    input.handle(10, { type: 'metadata', inputReceipt: { sequence: 1, outcome: 'accepted' } })
    expect(await fresh).toBe(true)
  })

  it('latches synchronous socket failure and disposes receipt timers', async () => {
    vi.useFakeTimers()
    const { input, binary } = setup()
    binary.mockReturnValue(false)
    expect(await input.send('t', 'a')).toBe(false)
    expect(await input.send('t', 'b')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
