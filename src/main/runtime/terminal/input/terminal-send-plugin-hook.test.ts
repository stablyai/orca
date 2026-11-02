import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../../../shared/plugins/workers/plugin-hook-chain'
import {
  PluginHookDeniedError,
  setPluginHookRunner
} from '../../../plugins/hooks/plugin-hook-dispatch'
import {
  runTerminalSendPluginHook,
  terminalHookOrderKind,
  TerminalPluginHookOrder,
  terminalSendHookApplies
} from './terminal-send-plugin-hook'

function installRunner(
  decide: (payload: unknown) => PluginHookChainOutcome | Promise<PluginHookChainOutcome>
) {
  const run = vi.fn(async (_event: PluginHookName, payload: unknown) => decide(payload))
  setPluginHookRunner({ wants: (event) => event === 'terminal.send', run })
  return run
}

const rewrite = (changes: Record<string, unknown>) => (payload: unknown) => ({
  kind: 'continue' as const,
  payload: { ...Object(payload), ...changes }
})
const allowed = vi.fn(async () => undefined)

afterEach(() => {
  setPluginHookRunner(null)
  allowed.mockClear()
})

describe('terminal.send hook site', () => {
  it('runs only for text Orca, the CLI or a plugin sends, never a person’s typing', () => {
    expect(terminalSendHookApplies({ text: 'ls' }, { inputKind: 'driving' })).toBe(false)
    installRunner(rewrite({}))
    const text = { text: 'ls' }
    expect(terminalSendHookApplies(text, { inputKind: 'driving' })).toBe(true)
    expect(
      terminalSendHookApplies(text, { inputKind: 'driving', inputSource: 'programmatic' })
    ).toBe(true)
    for (const inputSource of ['desktop', 'mobile', 'legacy'] as const) {
      expect(terminalSendHookApplies(text, { inputKind: 'driving', inputSource })).toBe(false)
    }
    expect(terminalSendHookApplies({ text: '\x1b[0n' }, { inputKind: 'query-reply' })).toBe(false)
    expect(terminalSendHookApplies({ enter: true }, { inputKind: 'driving' })).toBe(false)
  })

  it('sends what the chain decided, keeps an interrupt, and rechecks rewritten text', async () => {
    const run = installRunner(rewrite({ text: 'ls -la', enter: false }))
    await expect(
      runTerminalSendPluginHook(
        'term_1',
        { text: 'ls', enter: true, interrupt: true },
        'launch',
        allowed
      )
    ).resolves.toEqual({ text: 'ls -la', enter: false, interrupt: true })
    expect(run).toHaveBeenCalledWith('terminal.send', {
      terminalId: 'term_1',
      text: 'ls',
      enter: true,
      inputKind: 'launch'
    })
    expect(allowed).toHaveBeenCalledWith('ls -la')
  })

  it('refuses a rewrite the caller’s own checks would refuse, and skips them when unchanged', async () => {
    installRunner(rewrite({ text: 'claude --resume owned-by-chat' }))
    const refuse = vi.fn(async () => {
      throw new Error('legacy writer refused')
    })
    await expect(runTerminalSendPluginHook('t', { text: 'ls' }, 'driving', refuse)).rejects.toThrow(
      'legacy writer refused'
    )
    installRunner(rewrite({}))
    await runTerminalSendPluginHook('t', { text: 'ls' }, 'driving', refuse)
    expect(refuse).toHaveBeenCalledOnce()
  })

  it('refuses the send when a plugin denies it', async () => {
    installRunner(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'no rm' }))
    const sent = runTerminalSendPluginHook('t', { text: 'rm -rf /' }, 'orchestration', allowed)
    await expect(sent).rejects.toBeInstanceOf(PluginHookDeniedError)
    await expect(sent).rejects.toThrow('terminal.send denied by plugin acme.guard: no rm')
  })
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
