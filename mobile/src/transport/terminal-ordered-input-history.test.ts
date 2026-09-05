import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalOrderedInput, advertiseTerminalOrderedInput } from './terminal-ordered-input'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../src/shared/terminal-ordered-input'
import { assertTerminalInputRequestAllowed } from './terminal-input-request-fence'

function harness() {
  const binary = vi.fn(() => true)
  const input = new TerminalOrderedInput(binary)
  let next = 0
  const register = (terminal: string, compatible = true) => {
    const id = ++next
    input.register(`${id}`, advertiseTerminalOrderedInput('terminal.subscribe', { terminal }), {
      type: 'subscribed',
      streamId: id,
      capabilities: compatible ? { orderedInput: TERMINAL_ORDERED_INPUT_CAPABILITY } : {}
    })
    return id
  }
  const receipt = (id: number, outcome: string) =>
    input.handle(id, { type: 'metadata', inputReceipt: { sequence: 1, outcome } })
  return { input, binary, register, receipt }
}
afterEach(() => vi.useRealTimers())

describe('bounded ordered input failure history', () => {
  it('bounds 2048 failed identities without retaining timers, pending payloads, or unsafe fallback', async () => {
    vi.useFakeTimers()
    const { input, register, receipt } = harness()
    for (let i = 0; i < 2048; i++) {
      const terminal = `t-${i}`
      const id = register(terminal)
      const pending = input.send(terminal, 'secret-prefix')!
      receipt(id, 'unknown')
      expect(await pending).toBe(false)
      input.reset(`${id}`)
      const state = input as unknown as {
        byTerminal: Map<string, unknown>
        retainedFailures: Set<{ pending: Map<number, unknown>; pendingBytes: number }>
        streams: Map<string, unknown>
      }
      expect(state.byTerminal.size).toBeLessThanOrEqual(256)
      expect(state.retainedFailures.size).toBeLessThanOrEqual(256)
      for (const failure of state.retainedFailures) {
        expect(failure.pending.size).toBe(0)
        expect(failure.pendingBytes).toBe(0)
      }
      expect(state.streams.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
    expect(input.failure('t-0')).toEqual({ outcome: 'unknown', reason: 'input_history_limit' })
    expect(input.supports('t-0')).toBe(true)
    expect(await input.send('t-0', '\r')).toBe(false)
    expect(() =>
      assertTerminalInputRequestAllowed(
        'terminal.send',
        { terminal: 't-0' },
        input.failure.bind(input)
      )
    ).toThrow()
  })

  it('requires explicit fresh compatible recovery after overflow and bounds recovered permits', async () => {
    const { input, binary, register, receipt } = harness()
    register('stale')
    input.fence()
    expect(input.recover('stale')).toBe(false)
    register('old', false)
    expect(input.recover('old')).toBe(false)
    for (let i = 0; i < 300; i++) {
      const terminal = `recovered-${i}`
      const id = register(terminal)
      expect(await input.send(terminal, 'blocked')).toBe(false)
      expect(input.recover(terminal)).toBe(true)
      const accepted = input.send(terminal, 'a')!
      receipt(id, 'accepted')
      expect(await accepted).toBe(true)
    }
    const state = input as unknown as { permits: Set<unknown> }
    expect(state.permits.size).toBe(256)
    expect(await input.send('recovered-0', '\r')).toBe(false)
    expect(input.recover('recovered-0')).toBe(false)
    expect(binary).toHaveBeenCalledTimes(300)
    input.clear()
    expect(state.permits.size).toBe(0)
    expect(input.failure('recovered-299')?.outcome).toBe('unknown')
  })
})
