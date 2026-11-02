import './unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { GENERATED_INPUT_METHODS } from './methods/generated-input'
import type { RpcContext } from './core'
import { TerminalSendGeneratedInputParams } from '../../../shared/rpc-contract/generated-input-params'
import { MOBILE_RPC_METHOD_ROUTES } from '../runtime-rpc/runtime-rpc-mobile-method-routing'

const send = GENERATED_INPUT_METHODS.find(
  (method) => method.name === 'terminal.sendGeneratedInput'
)!

it('takes a send whose agent is not identified yet, and routes phones to the owning host', () => {
  const parsed = TerminalSendGeneratedInputParams.safeParse({
    terminal: 't1',
    text: 'go',
    submit: true,
    agent: null
  })
  expect(parsed.success).toBe(true)
  expect(MOBILE_RPC_METHOD_ROUTES.get('terminal.sendGeneratedInput')).toBe('execution-host')
})

// A later part naming another terminal or intent once appended text bound for a different target.
it('refuses a later part that names another terminal than the first, and writes nothing', async () => {
  const resolveGeneratedInputTarget = vi.fn()
  // SAFETY: a refused part never reaches the runtime; the spy proves it.
  const context = {
    runtime: { resolveGeneratedInputTarget },
    connectionId: 'phone'
  } as unknown as RpcContext
  const base = { submit: true, agent: 'claude', intent: 'running' as const }
  const part = (terminal: string, index: number, final: boolean) =>
    send.handler(
      TerminalSendGeneratedInputParams.parse({
        ...base,
        terminal,
        text: `p${index}`,
        part: { id: 'op-1', index, final }
      }),
      context
    )
  await expect(part('t1', 0, false)).resolves.toEqual({ part: 'accepted' })
  await expect(part('t2', 1, true)).rejects.toThrow(/out of order/)
  // The refused operation is gone: its final part cannot complete it either.
  await expect(part('t1', 1, true)).rejects.toThrow(/out of order/)
  expect(resolveGeneratedInputTarget).not.toHaveBeenCalled()
})
