import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RuntimeTerminalWriter, type RuntimeTerminalWriteOptions } from '../runtime-terminal-writer'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function fixture() {
  const binding = { ptyId: 'pty-1', incarnation: 'inc-1', writePtyId: 'pty-1' }
  const write = vi.fn(() => true)
  const writer = new RuntimeTerminalWriter(write)
  let beforeDelivery = async (): Promise<void> => {}
  const sendTerminal = vi.fn(
    async (
      handle: string,
      action: { text?: string; enter?: boolean; interrupt?: boolean },
      options: RuntimeTerminalWriteOptions
    ) => {
      await beforeDelivery()
      await writer.writeAction(binding.writePtyId, action, action.text ?? '\r', options)
      return { handle, accepted: true, bytesWritten: 1 }
    }
  )
  const runtime = {
    getRuntimeId: () => 'runtime',
    resolveLiveLeafForHandle: () => ({ ptyId: binding.ptyId }),
    getTerminalProcessIncarnation: vi.fn(() => `${binding.ptyId}:${binding.incarnation}`),
    getDriver: () => ({ kind: 'idle' }),
    getTerminalAgentStatus: vi.fn(async () => ({ isRunningAgent: true, status: 'working' })),
    sendTerminal
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  return {
    binding,
    write,
    runtime,
    sendTerminal,
    beforeDelivery(callback: () => Promise<void>) {
      beforeDelivery = callback
    },
    send(params: Record<string, unknown> = {}) {
      return dispatcher.dispatch({
        id: 'send',
        authToken: 'token',
        method: 'terminal.send',
        params: { terminal: 'term-1', text: 'x', ...params }
      })
    }
  }
}

describe('terminal.send incarnation fence', () => {
  it('rejects a stale incarnation before dispatch or bytes', async () => {
    const test = fixture()
    const response = await test.send({ expectedIncarnationId: 'old-incarnation' })
    expect(response).toMatchObject({ ok: false, error: { message: 'terminal_handle_stale' } })
    expect(test.sendTerminal).not.toHaveBeenCalled()
    expect(test.write).not.toHaveBeenCalled()
  })

  it('preserves legacy sends without requesting incarnation evidence', async () => {
    const test = fixture()
    expect(await test.send()).toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(test.runtime.getTerminalProcessIncarnation).not.toHaveBeenCalled()
    expect(test.write).toHaveBeenCalledWith('pty-1', 'x')
  })

  it('delivers a matching incarnation', async () => {
    const test = fixture()
    expect(await test.send({ expectedIncarnationId: 'inc-1' })).toMatchObject({ ok: true })
    expect(test.write).toHaveBeenCalledOnce()
  })

  it('refuses a requested fence when the host has no incarnation evidence', async () => {
    const test = fixture()
    vi.mocked(test.runtime.getTerminalProcessIncarnation).mockReturnValue(null)
    expect(await test.send({ expectedIncarnationId: 'inc-1' })).toMatchObject({ ok: false })
    expect(test.sendTerminal).not.toHaveBeenCalled()
    expect(test.write).not.toHaveBeenCalled()
  })

  it('fences a rebind after beforeWrite resolves at the synchronous write reservation', async () => {
    const test = fixture()
    test.sendTerminal.mockImplementation(async (handle, _action, options) => {
      await options.beforeWrite?.('pty-1')
      test.binding.incarnation = 'replacement'
      options.reserveWrite?.('pty-1')
      test.write()
      return { handle, accepted: true, bytesWritten: 1 }
    })
    expect(await test.send({ expectedIncarnationId: 'inc-1' })).toMatchObject({
      ok: false,
      error: { message: 'terminal_handle_stale' }
    })
    expect(test.write).not.toHaveBeenCalled()
  })

  it.each(['incarnation', 'ptyId', 'writePtyId'] as const)(
    'rejects a changed %s after asynchronous dispatch before bytes',
    async (field) => {
      const test = fixture()
      test.beforeDelivery(async () => {
        await Promise.resolve()
        test.binding[field] = 'replacement'
      })
      expect(await test.send({ expectedIncarnationId: 'inc-1' })).toMatchObject({
        ok: false,
        error: { message: 'terminal_handle_stale' }
      })
      expect(test.write).not.toHaveBeenCalled()
    }
  )

  it('rechecks incarnation after the awaited agent-status guard', async () => {
    const test = fixture()
    let probes = 0
    vi.mocked(test.runtime.getTerminalAgentStatus).mockImplementation(async () => {
      if (++probes === 2) {
        test.binding.incarnation = 'replacement'
      }
      return { handle: 'term-1', isRunningAgent: true, status: 'working' }
    })
    expect(
      await test.send({ expectedIncarnationId: 'inc-1', requireAgentStatus: 'sendable' })
    ).toMatchObject({ ok: false, error: { message: 'terminal_handle_stale' } })
    expect(test.write).not.toHaveBeenCalled()
  })
})

describe('terminal.send registered runtime identity', () => {
  it.each(['local-pty', 'ssh:target@@relay-pty'])(
    'uses the registered incarnation for %s without inspecting processes',
    async (ptyId) => {
      const runtime = new OrcaRuntimeService(null)
      const write = vi.fn(() => true)
      const inspect = vi.fn(async () => null)
      runtime.setPtyController({ write, kill: vi.fn(() => true), getForegroundProcess: inspect })
      const handle = runtime.preAllocateHandleForPty(ptyId)
      runtime.registerPty(ptyId, 'repo::workspace', 'target', {
        incarnationId: 'current',
        tabId: 'test-tab',
        leafId: '11111111-1111-4111-8111-111111111111'
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'test-tab',
            worktreeId: 'repo::workspace',
            title: 'Terminal',
            activeLeafId: '11111111-1111-4111-8111-111111111111',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'test-tab',
            worktreeId: 'repo::workspace',
            leafId: '11111111-1111-4111-8111-111111111111',
            paneRuntimeId: 1,
            ptyId
          }
        ]
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const send = (expectedIncarnationId: string) =>
        dispatcher.dispatch({
          id: 'send',
          authToken: 'token',
          method: 'terminal.send',
          params: { terminal: handle, text: 'draft', expectedIncarnationId }
        })
      expect(await send('old')).toMatchObject({
        ok: false,
        error: { message: 'terminal_handle_stale' }
      })
      expect(write).not.toHaveBeenCalled()
      const response = await send('current')
      expect(response, JSON.stringify(response)).toMatchObject({
        ok: true,
        result: { send: { accepted: true } }
      })
      expect(write).toHaveBeenCalledExactlyOnceWith(ptyId, 'draft')
      expect(inspect).not.toHaveBeenCalled()
    }
  )
})
