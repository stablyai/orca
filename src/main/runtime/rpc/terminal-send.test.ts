import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../shared/clipboard-text'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../../shared/terminal/input/terminal-input'

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
      }),
      { caller: { kind: 'desktop' } }
    )

    await vi.waitFor(() =>
      expect(refreshRemoteDesktopViewer).toHaveBeenCalledWith('pty-1', 'desktop-1', 96, 32, true)
    )
    expect(sendTerminal).not.toHaveBeenCalled()
    releaseClaim()
    await expect(response).resolves.toMatchObject({ ok: true })
    expect(sendTerminal).toHaveBeenCalled()
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
      { inputKind: 'driving', inputSource: 'legacy', beforeWrite: undefined }
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
})
