import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_SEND_SEQUENCE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

type Sequence = { stream: string; seq: number }

/** A host whose write of `slowText` stays unfinished until `finishSlowWrite` is called. */
function hostWithOneSlowWrite(slowText: string) {
  const written: string[] = []
  let finishSlowWrite: () => void = () => {}
  const slowWrite = new Promise<void>((resolve) => {
    finishSlowWrite = resolve
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.send reads only these runtime members for a plain mobile write.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    resolveLiveLeafForHandle: () => ({ ptyId: 'pty-1' }),
    getDriver: () => ({ kind: 'idle' }),
    sendTerminal: vi.fn(async (handle: string, action: { text?: string }) => {
      if (action.text === slowText) {
        await slowWrite
      }
      written.push(action.text ?? '')
      return { handle, accepted: true, bytesWritten: action.text?.length ?? 0 }
    })
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  let requests = 0
  const send = (
    text: string,
    sequence?: Sequence,
    terminal = 'terminal-1',
    extra: Record<string, unknown> = {}
  ) => {
    requests += 1
    const request: RpcRequest = {
      id: `req-${requests}`,
      authToken: 'tok',
      method: 'terminal.send',
      params: { terminal, text, ...(sequence ? { sequence } : {}), ...extra }
    }
    return dispatcher.dispatch(request)
  }
  return { written, finishSlowWrite, send }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('terminal.send sequence', () => {
  it('advertises in-order application so clients know they may overlap sends', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_SEND_SEQUENCE_RUNTIME_CAPABILITY)
  })

  it('writes overlapping sequenced sends to the PTY in sequence order', async () => {
    const host = hostWithOneSlowWrite('a')

    const first = host.send('a', { stream: 'keys', seq: 1 })
    const second = host.send('b', { stream: 'keys', seq: 2 })
    await settle()
    expect(host.written).toEqual([])

    host.finishSlowWrite()
    const responses = await Promise.all([first, second])
    expect(host.written).toEqual(['a', 'b'])
    expect(responses.map((response) => response.ok)).toEqual([true, true])
  })

  it('writes sequenced sends in sequence order when the later one is dispatched first', async () => {
    const host = hostWithOneSlowWrite('none')

    const second = host.send('b', { stream: 'keys', seq: 2 })
    await settle()
    expect(host.written).toEqual([])

    await Promise.all([host.send('a', { stream: 'keys', seq: 1 }), second])
    expect(host.written).toEqual(['a', 'b'])
  })

  it('refuses a sequenced send whose turn has passed instead of writing it late', async () => {
    const host = hostWithOneSlowWrite('none')
    await host.send('a', { stream: 'keys', seq: 1 })

    const response = await host.send('again', { stream: 'keys', seq: 1 })

    expect(response).toMatchObject({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
    })
    expect(host.written).toEqual(['a'])
  })

  // Mixed versions: a client that predates the field must behave exactly as before.
  it('does not hold a send without a sequence behind a sequenced send still being written', async () => {
    const host = hostWithOneSlowWrite('a')

    const sequenced = host.send('a', { stream: 'keys', seq: 1 })
    const response = await host.send('b')

    expect(response.ok).toBe(true)
    expect(host.written).toEqual(['b'])
    host.finishSlowWrite()
    await sequenced
    expect(host.written).toEqual(['b', 'a'])
  })

  it('orders each terminal and each stream separately', async () => {
    const host = hostWithOneSlowWrite('a')

    const blocked = host.send('a', { stream: 'keys', seq: 1 })
    await host.send('wheel', { stream: 'gestures', seq: 1 })
    await host.send('other', { stream: 'keys', seq: 1 }, 'terminal-2')

    expect(host.written).toEqual(['wheel', 'other'])
    host.finishSlowWrite()
    await blocked
  })

  it('rejects a sequenced agent prompt, which would hold its stream for minutes', async () => {
    const host = hostWithOneSlowWrite('none')

    const response = await host.send('prompt', { stream: 'keys', seq: 1 }, 'terminal-1', {
      agentPrompt: true
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(host.written).toEqual([])
  })
})
