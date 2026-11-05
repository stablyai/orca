import { afterEach, describe, expect, it, vi } from 'vitest'

import { setPluginHookRunner } from '../../../plugins/hooks/plugin-hook-dispatch'
import { terminalHookOrderKind, TerminalPluginHookOrder } from './terminal-send-plugin-hook'

const allowed = vi.fn(async () => undefined)

afterEach(() => {
  setPluginHookRunner(null)
  allowed.mockClear()
})

describe('TerminalPluginHookOrder', () => {
  const pass = async <A>(value: A) => value

  it('holds a later write until the hooked decision before it, and only the decision', async () => {
    const order = new TerminalPluginHookOrder()
    const written: string[] = []
    let decide!: () => void
    const decided = new Promise<void>((resolve) => (decide = resolve))
    let finishDelivery!: () => void
    // A delivery that waits (on a permission prompt, say) must not hold what comes after it.
    const slowDelivery = new Promise<void>((resolve) => (finishDelivery = resolve))
    const text = order.run(
      't',
      'hooked',
      'text',
      async (value) => {
        await decided
        return value
      },
      async (value) => {
        written.push(value)
        await slowDelivery
      }
    )
    const enter = order.run(
      't',
      'ordered',
      'enter',
      pass,
      async (value) => void written.push(value)
    )
    const other = order.run(
      'u',
      'ordered',
      'other',
      pass,
      async (value) => void written.push(value)
    )
    await other
    expect(written).toEqual(['other'])
    decide()
    await enter
    expect(written).toEqual(['other', 'text', 'enter'])
    finishDelivery()
    await text
  })

  it('lets a person’s input and interrupts bypass a pending decision', async () => {
    const order = new TerminalPluginHookOrder()
    void order.run('t', 'hooked', 'x', () => new Promise<string>(() => undefined), pass)
    await expect(order.run('t', 'bypass', 'ctrl-c', pass, pass)).resolves.toBe('ctrl-c')
    expect(terminalHookOrderKind(false, { interrupt: true }, {})).toBe('bypass')
    expect(terminalHookOrderKind(false, {}, { inputSource: 'mobile' })).toBe('bypass')
    expect(terminalHookOrderKind(false, {}, { inputKind: 'query-reply' })).toBe('bypass')
    expect(terminalHookOrderKind(false, {}, { inputSource: 'programmatic' })).toBe('ordered')
    expect(terminalHookOrderKind(true, {}, {})).toBe('hooked')
  })

  it('keeps going after a denied send, and delivers unhooked writes at once when idle', async () => {
    const order = new TerminalPluginHookOrder()
    const denied = order.run(
      't',
      'hooked',
      'x',
      async () => {
        throw new Error('denied')
      },
      pass
    )
    await expect(denied).rejects.toThrow('denied')
    await expect(order.run('t', 'ordered', 'next', pass, pass)).resolves.toBe('next')
    const deliver = vi.fn(async (value: string) => value)
    const result = order.run<string, string>('idle', 'ordered', 'direct', pass, deliver)
    expect(deliver).toHaveBeenCalledOnce()
    await expect(result).resolves.toBe('direct')
  })
})
