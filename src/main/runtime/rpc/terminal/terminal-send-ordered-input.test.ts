import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatch/dispatcher-stream-options'
import { z } from 'zod'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-terminal-send-contract'

const mobile = { clientId: 'phone', caller: { kind: 'paired-device', deviceId: 'device' } } as const
const client = { id: 'phone', type: 'mobile' } as const

function fixture() {
  let binding = { ptyId: 'pty', processIncarnation: 'process', generation: 1 }
  const writes: string[] = []
  let release = (): void => {}
  let outcome: 'accepted' | 'refused' | 'unverifiable' = 'accepted'
  const sendTerminal: OrcaRuntimeService['sendTerminal'] = vi.fn(async (handle, input, options) => {
    await options?.beforeWrite?.('pty')
    if (input.text === 'held') {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    await options?.beforeWrite?.('pty')
    if (outcome === 'refused') {
      return { handle, accepted: false, bytesWritten: 0 }
    }
    writes.push(input.text ?? '')
    const send: RuntimeTerminalSend = {
      handle,
      accepted: true,
      bytesWritten: input.text?.length ?? 0,
      writeSettlement:
        outcome === 'accepted'
          ? { outcome: 'accepted' }
          : { outcome: 'unverifiable', reason: 'settlement_timeout', bytesHandedToTransport: true }
    }
    return send
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this dispatcher fixture implements the runtime members read by terminal.send and openInputSession.
  const runtime = {
    getRuntimeId: () => 'runtime',
    getTerminalPromptRequestBinding: () => binding,
    resolveLiveLeafForHandle: () => ({ ptyId: binding.ptyId }),
    getDriver: () => null,
    ensureStructuredAgentSessionHost: async () => null,
    sendTerminal,
    beginMobileInputFloor: () => ({ commit: async () => {}, rollback: () => {} })
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  let id = 0
  const call = (method: string, params: unknown, options: RpcDispatchStreamingOptions = mobile) =>
    dispatcher.dispatch({ id: String(++id), authToken: 'test', method, params }, options)
  const open = async () => {
    const response = await call('terminal.openInputSession', { terminal: 'term', client })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const parsed = z.object({ inputSessionId: z.string().nullable() }).parse(response.result)
    return parsed.inputSessionId
  }
  const send = (
    sessionId: string,
    seq: number,
    text: string,
    options: RpcDispatchStreamingOptions = mobile
  ) =>
    call(
      'terminal.send',
      { terminal: 'term', client, text, inputSequence: { sessionId, seq } },
      options
    )
  return {
    call,
    open,
    send,
    sendTerminal,
    writes,
    release: () => release(),
    replace: () => {
      binding = { ...binding, generation: 2 }
    },
    outcome: (value: typeof outcome) => {
      outcome = value
    }
  }
}

describe('ordered terminal input RPC', () => {
  it('serializes the complete send, deduplicates matching payloads, and pins the token while a predecessor is busy', async () => {
    const f = fixture()
    const token = (await f.open())!
    const first = f.send(token, 1, 'held')
    await vi.waitFor(() => expect(f.sendTerminal).toHaveBeenCalledTimes(1))
    const second = f.send(token, 2, 'next')
    const duplicate = f.send(token, 1, 'held')
    expect(await f.open()).toBeNull()
    await f.call('terminal.send', { terminal: 'term', text: 'bypass', client })
    expect(f.sendTerminal).toHaveBeenCalledTimes(1)
    f.release()
    await expect(Promise.all([first, second, duplicate])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({ send: expect.objectContaining({ accepted: true }) })
        })
      ])
    )
    expect(f.writes).toEqual(['held', 'next'])
    expect(f.sendTerminal).toHaveBeenLastCalledWith(
      'term',
      expect.anything(),
      expect.objectContaining({ inputSource: 'mobile', requireWriteSettlement: true })
    )
  })
})
