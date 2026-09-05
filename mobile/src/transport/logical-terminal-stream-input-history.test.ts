import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { LogicalTerminalStreamInput } from './logical-terminal-stream-input'
import { TerminalOrderedInput, advertiseTerminalOrderedInput } from './terminal-ordered-input'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../src/shared/terminal-ordered-input'

function physical() {
  const binary = vi.fn(() => true)
  const input = new TerminalOrderedInput(binary)
  const session = {
    sendTerminalStreamInput: input.send.bind(input),
    supportsTerminalStreamInput: input.supports.bind(input),
    getTerminalStreamInputFailure: input.failure.bind(input),
    recoverTerminalStreamInput: input.recover.bind(input),
    fenceTerminalStreamInput: input.fence.bind(input)
  } as unknown as RpcClient
  const register = (terminal: string, id = 1) =>
    input.register(`${id}`, advertiseTerminalOrderedInput('terminal.subscribe', { terminal }), {
      type: 'subscribed',
      streamId: id,
      capabilities: { orderedInput: TERMINAL_ORDERED_INPUT_CAPABILITY }
    })
  const receipt = (id: number, outcome: string) =>
    input.handle(id, { type: 'metadata', inputReceipt: { sequence: 1, outcome } })
  return { input, session, register, receipt, binary }
}

describe('bounded logical input failure history', () => {
  it('caps recovery grants and fails closed when a grant is evicted', async () => {
    const current = physical()
    const logical = new LogicalTerminalStreamInput(() => ({
      session: current.session,
      generation: 1,
      available: true
    }))
    logical.fence()
    for (let i = 1; i <= 300; i++) {
      const terminal = `t-${i}`
      current.register(terminal, i)
      expect(logical.recover(terminal)).toBe(true)
      const accepted = logical.send(terminal, 'a')!
      current.receipt(i, 'accepted')
      expect(await accepted).toBe(true)
    }
    expect((logical as unknown as { permits: Set<string> }).permits.size).toBe(256)
    expect(logical.failure('t-1')?.outcome).toBe('unknown')
    expect(await logical.send('t-1', '\r')).toBe(false)
    expect(logical.recover('t-1')).toBe(false)
    current.input.clear()
  })
  it('bounds 2048 failed identities across physical generations and preserves the earliest fence', async () => {
    let current = physical()
    let generation = 1
    const logical = new LogicalTerminalStreamInput(() => ({
      session: current.session,
      generation,
      available: true
    }))
    for (let i = 0; i < 2048; i++) {
      current = physical()
      generation++
      current.register(`t-${i}`)
      const pending = logical.send(`t-${i}`, 'x')!
      current.receipt(1, 'unknown')
      expect(await pending).toBe(false)
      current.input.clear()
      expect(
        (logical as unknown as { attempts: Map<string, unknown> }).attempts.size
      ).toBeLessThanOrEqual(256)
    }
    expect(logical.failure('t-0')?.outcome).toBe('unknown')
    expect(logical.supports('t-0')).toBe(true)
    expect(await logical.send('t-0', '\r')).toBe(false)
    expect(logical.recover('t-0')).toBe(false)
    current.register('t-0', 2)
    expect(await logical.send('t-0', 'blocked')).toBe(false)
    expect(logical.recover('t-0')).toBe(true)
    const accepted = logical.send('t-0', 'new')!
    current.receipt(2, 'accepted')
    expect(await accepted).toBe(true)
  })

  it('rejects stale candidates, old clients, and late completions across a fence and recovery', async () => {
    let current = physical()
    let generation = 1
    const logical = new LogicalTerminalStreamInput(() => ({
      session: current.session,
      generation,
      available: true
    }))
    current.register('t')
    const old = logical.send('t', 'prefix')!
    logical.fence()
    expect(logical.recover('t')).toBe(false)
    current.register('t', 2)
    expect(logical.recover('t')).toBe(true)
    expect(await old).toBe(false)
    expect(logical.failure('t')).toBe(null)
    const accepted = logical.send('t', 'new')!
    current.receipt(1, 'unknown')
    current.receipt(2, 'accepted')
    expect(await accepted).toBe(true)
    current = physical()
    generation++
    current.register('t')
    expect(logical.recover('t')).toBe(false)
    current.session = {} as RpcClient
    generation++
    expect(logical.recover('t')).toBe(false)
    expect(await logical.send('t', '\r')).toBe(false)
  })
})
