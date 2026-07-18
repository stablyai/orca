import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../shared/clipboard-text'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../../shared/terminal-input'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    beginMobileInputFloor: vi.fn((ptyId: string, clientId: string) => ({
      commit: async () => {
        await overrides.mobileTookFloor?.(ptyId, clientId)
      },
      rollback: vi.fn()
    })),
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal send RPC', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports whether a terminal handle is running a recognized agent', async () => {
    const runtime = stubRuntime({
      isTerminalRunningAgent: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.isRunningAgent', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({ isRunningAgent: true })
    expect(runtime.isTerminalRunningAgent).toHaveBeenCalledWith('terminal-1')
  })

  it('reports runtime-owned terminal agent status', async () => {
    const runtime = stubRuntime({
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'permission'
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.agentStatus', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      agentStatus: {
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'permission'
      }
    })
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledWith('terminal-1')
  })

  it('fails terminal.send with terminal_handle_stale for a stale handle instead of probing the wrong PTY', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(() => {
        throw new Error('terminal_handle_stale')
      }),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'stale-terminal',
        text: 'x',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(false)
    if (response.ok) {
      throw new Error('expected stale handle error')
    }
    expect(response.error.message).toContain('terminal_handle_stale')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('drops desktop input while a mobile client owns the terminal floor', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      sendTerminal: vi.fn(),
      mobileTookFloor: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0
      }
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(runtime.mobileTookFloor).not.toHaveBeenCalled()
  })

  it('awaits a desktop viewport claim before acknowledged input', async () => {
    let releaseClaim = (): void => {}
    const refreshRemoteDesktopViewer = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseClaim = () => resolve(true)
        })
    )
    const sendTerminal = vi.fn().mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite?.('pty-1')
      return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
    })
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      refreshRemoteDesktopViewer,
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: '\x03',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 96, rows: 32 },
        claimViewport: true
      })
    )

    await vi.waitFor(() =>
      expect(refreshRemoteDesktopViewer).toHaveBeenCalledWith('pty-1', 'desktop-1', 96, 32, true)
    )
    expect(sendTerminal).not.toHaveBeenCalled()
    releaseClaim()
    await expect(response).resolves.toMatchObject({ ok: true })
    expect(sendTerminal).toHaveBeenCalled()
  })

  it('accepts legacy clientless mobile input when the current driver is mobile', async () => {
    const write = vi.fn()
    const sendTerminal = vi.fn().mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite?.('pty-1')
      options.reserveWrite?.('pty-1')
      write()
      await options.afterWrite?.('pty-1')
      await options.beforeWrite?.('pty-1')
      options.reserveWrite?.('pty-1')
      write()
      await options.afterWrite?.('pty-1')
      return {
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 1
      }
    })
    const mobileTookFloor = vi.fn().mockResolvedValue(undefined)
    const beginMobileInputFloor = vi.fn(() => ({
      commit: async () => mobileTookFloor('pty-1', 'mobile-1'),
      rollback: vi.fn()
    }))
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      sendTerminal,
      beginMobileInputFloor,
      mobileTookFloor
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({ send: { accepted: true, bytesWritten: 1 } })
    expect(runtime.sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      {
        text: 'x',
        enter: false,
        interrupt: false
      },
      {
        beforeWrite: undefined,
        reserveWrite: expect.any(Function),
        afterWrite: expect.any(Function)
      }
    )
    expect(runtime.mobileTookFloor).toHaveBeenCalledWith('pty-1', 'mobile-1')
    expect(beginMobileInputFloor).toHaveBeenCalledTimes(2)
    expect(runtime.mobileTookFloor).toHaveBeenCalledTimes(2)
    expect(beginMobileInputFloor.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]!
    )
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(
      mobileTookFloor.mock.invocationCallOrder[0]!
    )
  })

  it.each([
    ['rejects', async () => ({ handle: 'terminal-1', accepted: false, bytesWritten: 0 })],
    [
      'throws',
      async () => {
        throw new Error('write failed')
      }
    ]
  ])('rolls back a mobile floor claim when the terminal write %s', async (_case, finishWrite) => {
    const commit = vi.fn()
    const rollback = vi.fn()
    const beginMobileInputFloor = vi.fn(() => ({ commit, rollback }))
    const sendTerminal = vi.fn().mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite?.('pty-1')
      options.reserveWrite?.('pty-1')
      return finishWrite()
    })
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      sendTerminal,
      beginMobileInputFloor
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'mobile-1', type: 'mobile' }
      })
    )

    expect(beginMobileInputFloor).toHaveBeenCalledWith('pty-1', 'mobile-1')
    expect(beginMobileInputFloor).toHaveBeenCalledOnce()
    expect(rollback).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('writes zero bytes when the mobile subscriber disappeared before reservation', async () => {
    const write = vi.fn()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      beginMobileInputFloor: vi.fn().mockReturnValue(null),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        options.reserveWrite('pty-1')
        write()
        return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', { terminal: 'terminal-1', text: 'stale' })
    )

    expect(response.ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('reclaims the mobile floor for a delayed suffix and preserves the earlier commit', async () => {
    const commit = vi.fn()
    const rollback = vi.fn()
    const beginMobileInputFloor = vi.fn(() => ({ commit: async () => commit(), rollback }))
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      beginMobileInputFloor,
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite?.('pty-1')
        options.reserveWrite('pty-1')
        await options.afterWrite('pty-1')
        await options.beforeWrite?.('pty-1')
        options.reserveWrite('pty-1')
        throw new Error('suffix failed')
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'partial',
        enter: true,
        client: { id: 'mobile-1', type: 'mobile' }
      })
    )

    expect(beginMobileInputFloor).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledOnce()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('writes a validated terminal query reply without taking the mobile floor', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 6
      }),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true),
      mobileTookFloor: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: '\x1b[3;4R',
        enter: false,
        inputKind: 'query-reply',
        client: { id: 'mobile-1', type: 'mobile' }
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      { text: '\x1b[3;4R', enter: false, interrupt: false },
      { beforeWrite: undefined }
    )
    expect(runtime.mobileTookFloor).not.toHaveBeenCalled()
  })

  it('accepts a query reply from only the elected mobile subscriber', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      isMobileTerminalQueryReplyAuthority: vi.fn(
        (_ptyId: string, clientId: string) => clientId === 'mobile-1'
      ),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 6
      }),
      mobileTookFloor: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const makeReply = (clientId: string) =>
      dispatcher.dispatch(
        makeRequest('terminal.send', {
          terminal: 'terminal-1',
          text: '\x1b[3;4R',
          inputKind: 'query-reply',
          client: { id: clientId, type: 'mobile' }
        })
      )
    const [winner, peer] = await Promise.all([makeReply('mobile-1'), makeReply('mobile-2')])

    expect(winner).toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(peer).toMatchObject({ ok: true, result: { send: { accepted: false } } })
    expect(runtime.sendTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.mobileTookFloor).not.toHaveBeenCalled()
  })

  it('rejects ordinary input that claims to be a terminal query reply', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(),
      sendTerminal: vi.fn(),
      mobileTookFloor: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'a',
        inputKind: 'query-reply',
        client: { id: 'mobile-1', type: 'mobile' }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.resolveLiveLeafForHandle).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(runtime.mobileTookFloor).not.toHaveBeenCalled()
  })

  it.each([
    ['enter', { enter: true }],
    ['interrupt', { interrupt: true }],
    ['agent guard', { requireAgentStatus: 'sendable' }]
  ])('rejects a terminal query reply combined with %s semantics', async (_case, extra) => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: '\x1b[3;4R',
        inputKind: 'query-reply',
        client: { id: 'mobile-1', type: 'mobile' },
        ...extra
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.resolveLiveLeafForHandle).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('rejects query replies that spoof a different authenticated mobile client', async () => {
    const replies: string[] = []
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: '\x1b[3;4R',
        inputKind: 'query-reply',
        client: { id: 'spoofed-mobile', type: 'mobile' }
      }),
      (reply) => replies.push(reply),
      { clientId: 'authenticated-mobile' }
    )

    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(runtime.resolveLiveLeafForHandle).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('rejects oversized terminal send text before runtime dispatch', async () => {
    const secret = 'terminal-send-secret'
    const runtime = stubRuntime({
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: [secret, 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)].join('')
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: TERMINAL_INPUT_TOO_LARGE_ERROR
      }
    })
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('rejects multibyte oversized terminal send text before runtime dispatch', async () => {
    const runtime = stubRuntime({
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const text = '😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1)

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text
      })
    )

    expect(text.length).toBeLessThan(TERMINAL_INPUT_MAX_BYTES)
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: TERMINAL_INPUT_TOO_LARGE_ERROR
      }
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('yields while validating large accepted terminal send text before runtime dispatch', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: text.length
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const responsePromise = dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text
      })
    )
    await Promise.resolve()

    expect(runtime.sendTerminal).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(runtime.sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      {
        text,
        enter: false,
        interrupt: false
      },
      { beforeWrite: undefined }
    )
  })

  it('refuses guarded terminal sends when the agent needs permission', async () => {
    const beginMobileInputFloor = vi.fn()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'permission'
      }),
      sendTerminal: vi.fn(),
      beginMobileInputFloor
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'mobile-1', type: 'mobile' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0,
        refusedReason: 'permission'
      }
    })
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledWith('terminal-1')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(beginMobileInputFloor).not.toHaveBeenCalled()
  })

  it('allows guarded terminal sends when the agent is sendable', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'working'
      }),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 1
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({ send: { accepted: true, bytesWritten: 1 } })
    expect(runtime.sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      {
        text: undefined,
        enter: true,
        interrupt: false
      },
      { beforeWrite: expect.any(Function) }
    )
  })

  it('writes zero bytes when a guarded callback observes a handle rebind during status', async () => {
    let boundPtyId = 'pty-1'
    let statusCalls = 0
    const write = vi.fn()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: boundPtyId })),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn().mockImplementation(async () => {
        statusCalls += 1
        if (statusCalls === 2) {
          boundPtyId = 'pty-2'
        }
        return {
          handle: 'terminal-1',
          isRunningAgent: true,
          status: 'working'
        }
      }),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite('pty-1')
        write('pty-1', '\r')
        return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledTimes(2)
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects a guarded callback whose actual write PTY differs from the handle binding', async () => {
    const write = vi.fn()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: 'pty-1' })),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'working'
      }),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite('pty-2')
        write('pty-2', '\r')
        return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses guarded combined text and submit sends before any PTY write', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn(),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'notes',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0
      }
    })
    expect(runtime.getTerminalAgentStatus).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('rechecks the mobile floor lock immediately before guarded PTY writes', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi
        .fn()
        .mockReturnValueOnce({ kind: 'desktop' })
        .mockReturnValueOnce({ kind: 'desktop' })
        .mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'working'
      }),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite('pty-1')
        return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0
      }
    })
  })

  it('routes terminal restore fit through the runtime driver state machine', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      reclaimTerminalForDesktop: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.restoreFit', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({ restored: true })
    expect(runtime.reclaimTerminalForDesktop).toHaveBeenCalledWith('pty-1')
  })
  // Why: mobile gates reply forwarding on this static capability; removing it
  // would silently re-break mobile query answering against current hosts.
  it('advertises query-reply input support to mobile clients', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY)
  })
})
