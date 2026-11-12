import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../../../shared/terminal/input/terminal-input'

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
})
