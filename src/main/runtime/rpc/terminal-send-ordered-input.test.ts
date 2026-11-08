import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { z } from 'zod'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeTerminalSend } from '../../../shared/runtime-terminal-send-contract'

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

  it.each(['refused', 'unverifiable'] as const)(
    'poisons the suffix after %s and never retries ambiguous input',
    async (outcome) => {
      const f = fixture()
      const token = (await f.open())!
      f.outcome(outcome)
      await f.send(token, 1, 'a')
      f.outcome('accepted')
      await f.send(token, 1, 'a')
      await f.send(token, 2, '\r')
      expect(f.writes).toEqual(outcome === 'refused' ? [] : ['a'])
    }
  )

  it('retires an idle strict token when a legacy predecessor becomes busy', async () => {
    const f = fixture()
    const token = (await f.open())!
    await f.send(token, 1, 'warm')
    const legacy = f.call('terminal.send', { terminal: 'term', client, text: 'held' })
    await vi.waitFor(() => expect(f.sendTerminal).toHaveBeenCalledTimes(2))
    try {
      expect(await f.send(token, 2, 'suffix')).toMatchObject({
        ok: true,
        result: { send: { accepted: false } }
      })
      expect(f.sendTerminal).toHaveBeenCalledTimes(2)
    } finally {
      f.release()
      await legacy
    }
    await f.send(token, 2, 'suffix')
    expect(f.writes).toEqual(['warm', 'held'])
  })

  it('charges queued launch-draft payloads before appending them behind a held write', async () => {
    const f = fixture()
    const token = (await f.open())!
    const first = f.send(token, 1, 'held')
    await vi.waitFor(() => expect(f.sendTerminal).toHaveBeenCalledTimes(1))
    const payload = {
      terminal: 'term',
      client,
      text: '',
      resolvedLaunchDraft: { text: 'x'.repeat(9 * 1024 * 1024), createdAt: 0 }
    }
    const second = f.call('terminal.send', {
      ...payload,
      inputSequence: { sessionId: token, seq: 2 }
    })
    let refused = false
    const third = f
      .call('terminal.send', { ...payload, inputSequence: { sessionId: token, seq: 3 } })
      .then((reply) => {
        refused =
          reply.ok &&
          z.object({ send: z.object({ accepted: z.boolean() }) }).parse(reply.result).send
            .accepted === false
      })
    try {
      await vi.waitFor(() => expect(refused).toBe(true), { timeout: 100 })
      expect(f.sendTerminal).toHaveBeenCalledTimes(1)
    } finally {
      f.release()
      await Promise.all([first, second, third])
    }
  })

  it('charges raw controls retained by the dispatcher while normalized sends wait', async () => {
    const f = fixture()
    const token = (await f.open())!
    const first = f.send(token, 1, 'held')
    await vi.waitFor(() => expect(f.sendTerminal).toHaveBeenCalledTimes(1))
    const pending = Array.from({ length: 25 }, (_, index) =>
      f.call('terminal.send', {
        terminal: 'term',
        client,
        text: 'x',
        enter: 'e'.repeat(350 * 1024) + index,
        interrupt: 'i'.repeat(350 * 1024) + index,
        inputSequence: { sessionId: token, seq: index + 2 }
      })
    )
    let refused = false
    void pending.at(-1)!.then((reply) => {
      refused =
        reply.ok &&
        z.object({ send: z.object({ accepted: z.boolean() }) }).parse(reply.result).send
          .accepted === false
    })
    try {
      await vi.waitFor(() => expect(refused).toBe(true), { timeout: 100 })
      expect(f.sendTerminal).toHaveBeenCalledTimes(1)
    } finally {
      f.release()
      await Promise.all([first, ...pending])
    }
  })

  it('keeps a cancelled queued request behind its predecessor and never writes its suffix', async () => {
    const f = fixture()
    const token = (await f.open())!
    const first = f.send(token, 1, 'held')
    await vi.waitFor(() => expect(f.sendTerminal).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const suffix = f.send(token, 2, '\r', { ...mobile, signal: controller.signal })
    controller.abort()
    expect(await f.open()).toBeNull()
    f.release()
    await Promise.all([first, suffix])
    expect(f.writes).toEqual(['held'])
  })

  it('rechecks the full binding before a later chunk and suppresses its dependent Return', async () => {
    const f = fixture()
    const token = (await f.open())!
    const first = f.send(token, 1, 'held')
    await vi.waitFor(() => expect(f.sendTerminal).toHaveBeenCalledTimes(1))
    const suffix = f.send(token, 2, '\r')
    f.replace()
    f.release()
    await Promise.all([first, suffix])
    expect(f.writes).toEqual([])
  })
})
