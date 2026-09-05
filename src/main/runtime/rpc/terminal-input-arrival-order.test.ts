import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RuntimeTerminalWriter } from '../runtime-terminal-writer'
import * as terminalPayload from '../terminal-send-payload'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'
import {
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function runtimeFixture() {
  const writes: string[] = []
  const generations = new Map([['pty-1', 1]])
  const writer = new RuntimeTerminalWriter(
    (_pty, text) => {
      writes.push(text)
      return true
    },
    () => 'linux',
    (pty) => generations.get(pty)
  )
  const runtime: OrcaRuntimeService = Object.assign(Object.create(OrcaRuntimeService.prototype), {
    getRuntimeId: () => 'arrival-test',
    ptyLifecycleGenerationById: generations,
    getPtyLifecycleGeneration: (pty: string) => generations.get(pty),
    getLivePtyForHandle: () => ({ pty: { ptyId: 'pty-1', connected: true } }),
    resolveLiveLeafForHandle: () => ({ ptyId: 'pty-1' }),
    getDriver: () => ({ kind: 'idle' }),
    writeTerminalAction: writer.writeAction.bind(writer)
  })
  return { runtime, writes, generations }
}

function inputFrame(text: string, opcode = TerminalStreamOpcode.Input) {
  return decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode,
      streamId: 7,
      seq: 1,
      payload: encodeTerminalStreamText(text)
    })
  )!
}

describe('terminal input ordering before RPC and runtime validation', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['dispatch', 'dispatchStreaming'] as const)(
    '%s reserves text before a later JSON Enter',
    async (entry) => {
      const f = runtimeFixture()
      const held = deferred()
      vi.spyOn(terminalPayload, 'assertTerminalInputWithinLimitWithYield').mockImplementationOnce(
        () => held.promise
      )
      const dispatcher = new RpcDispatcher({ runtime: f.runtime, methods: TERMINAL_METHODS })
      const replies: string[] = []
      const send = (params: object) =>
        entry === 'dispatch'
          ? dispatcher.dispatch(makeRequest('terminal.send', params))
          : dispatcher.dispatchStreaming(makeRequest('terminal.send', params), (r) =>
              replies.push(r)
            )
      const first = send({ terminal: 'terminal-1', text: 'text' })
      const enter = send({ terminal: 'terminal-1', enter: true })
      await vi.waitFor(() =>
        expect(terminalPayload.assertTerminalInputWithinLimitWithYield).toHaveBeenCalledOnce()
      )
      expect(f.writes).toEqual([])
      held.resolve()
      await Promise.all([first, enter])
      expect(f.writes).toEqual(['text', '\r'])
    }
  )

  it.each(['json-first', 'binary-first'] as const)(
    '%s shares arrival order across dispatch and multiplex input',
    async (order) => {
      const f = runtimeFixture()
      const held = deferred()
      vi.spyOn(terminalPayload, 'assertTerminalInputWithinLimitWithYield').mockImplementationOnce(
        () => held.promise
      )
      const h = startDesktopMultiplexSubscribe({
        captureTerminalInputArrivalTarget: f.runtime.captureTerminalInputArrivalTarget.bind(
          f.runtime
        ),
        sendTerminal: f.runtime.sendTerminal.bind(f.runtime)
      })
      await vi.waitFor(() => expect(h.handlers.has(0)).toBe(true))
      sendDesktopMultiplexSubscribe(h.handlers)
      await vi.waitFor(() => expect(h.handlers.has(7)).toBe(true))
      const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: TERMINAL_METHODS })
      const sendJson = (params: object) =>
        dispatcher.dispatch(
          makeRequest('terminal.send', {
            terminal: 'terminal-1',
            ...params
          })
        )
      let json: ReturnType<typeof sendJson>
      if (order === 'json-first') {
        json = sendJson({ text: 'text' })
        h.handlers.get(7)!(inputFrame('\r'))
      } else {
        h.handlers.get(7)!(inputFrame('text'))
        json = sendJson({ enter: true })
      }
      await vi.waitFor(() =>
        expect(terminalPayload.assertTerminalInputWithinLimitWithYield).toHaveBeenCalledOnce()
      )
      expect(f.writes).toEqual([])
      held.resolve()
      await json
      await vi.waitFor(() => expect(f.writes).toEqual(['text', '\r']))
      h.handlers.get(7)!(inputFrame('', TerminalStreamOpcode.Unsubscribe))
    }
  )

  it('detaching a multiplex stream cancels active and queued input before provider writes', async () => {
    const f = runtimeFixture()
    const held = deferred()
    vi.spyOn(terminalPayload, 'assertTerminalInputWithinLimitWithYield').mockImplementationOnce(
      () => held.promise
    )
    const h = startDesktopMultiplexSubscribe({
      captureTerminalInputArrivalTarget: f.runtime.captureTerminalInputArrivalTarget.bind(
        f.runtime
      ),
      sendTerminal: f.runtime.sendTerminal.bind(f.runtime)
    })
    await vi.waitFor(() => expect(h.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(h.handlers)
    await vi.waitFor(() => expect(h.handlers.has(7)).toBe(true))
    const frame = h.handlers.get(7)!
    frame(inputFrame('text'))
    frame(inputFrame('\r'))
    await vi.waitFor(() =>
      expect(terminalPayload.assertTerminalInputWithinLimitWithYield).toHaveBeenCalledOnce()
    )
    frame(inputFrame('', TerminalStreamOpcode.Unsubscribe))
    held.resolve()
    const response = await new RpcDispatcher({
      runtime: h.runtime,
      methods: TERMINAL_METHODS
    }).dispatch(makeRequest('terminal.send', { terminal: 'terminal-1', text: 'live' }))
    expect(response.ok).toBe(true)
    expect(f.writes).toEqual(['live'])
  })

  it('pins the real runtime generation before validation and rejects queued replacement writes', async () => {
    const f = runtimeFixture()
    const held = deferred()
    vi.spyOn(terminalPayload, 'assertTerminalInputWithinLimitWithYield').mockImplementationOnce(
      () => held.promise
    )
    const dispatcher = new RpcDispatcher({ runtime: f.runtime, methods: TERMINAL_METHODS })
    const first = dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'old'
      })
    )
    const enter = dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true
      })
    )
    await vi.waitFor(() =>
      expect(terminalPayload.assertTerminalInputWithinLimitWithYield).toHaveBeenCalledOnce()
    )
    f.generations.set('pty-1', 2)
    held.resolve()
    for (const response of await Promise.all([first, enter])) {
      expect(response).toMatchObject({ ok: false, error: { message: 'terminal_handle_stale' } })
    }
    expect(f.writes).toEqual([])
  })

  it.each(['generation', 'binding'] as const)(
    'an old multiplex subscription cannot adopt a new %s before its next input',
    async (change) => {
      const f = runtimeFixture()
      const sendTerminal = vi.fn(f.runtime.sendTerminal.bind(f.runtime))
      const h = startDesktopMultiplexSubscribe({
        captureTerminalInputArrivalTarget: f.runtime.captureTerminalInputArrivalTarget.bind(
          f.runtime
        ),
        sendTerminal
      })
      await vi.waitFor(() => expect(h.handlers.has(0)).toBe(true))
      sendDesktopMultiplexSubscribe(h.handlers, { writeUnavailable: 1 })
      await vi.waitFor(() => expect(h.handlers.has(7)).toBe(true))
      if (change === 'generation') {
        f.generations.set('pty-1', 2)
      } else {
        f.generations.set('pty-2', 1)
        Object.assign(f.runtime, {
          getLivePtyForHandle: () => ({ pty: { ptyId: 'pty-2', connected: true } })
        })
      }
      h.handlers.get(7)!(inputFrame('old stream'))
      h.handlers.get(7)!(inputFrame('\r'))
      await vi.waitFor(() =>
        expect(
          h.binaryFrames.some(
            (bytes) =>
              decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.WriteUnavailable
          )
        ).toBe(true)
      )
      expect(sendTerminal).not.toHaveBeenCalled()
      expect(f.writes).toEqual([])
      h.handlers.get(7)!(inputFrame('', TerminalStreamOpcode.Unsubscribe))
    }
  )
})
