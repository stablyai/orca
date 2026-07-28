import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_INPUT_QUEUE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { TerminalInputQueueIdempotency } from '../terminal-input-queue-idempotency'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.send', params }
}

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  const idempotency = new TerminalInputQueueIdempotency()
  return {
    getRuntimeId: () => 'test-runtime',
    beginMobileInputFloor: vi.fn(() => ({
      commit: vi.fn(),
      rollback: vi.fn()
    })),
    runTerminalInputQueueOperation: (clientIdentity, queueId, sequence, fingerprint, operation) =>
      idempotency.run(clientIdentity, queueId, sequence, fingerprint, operation),
    ...overrides
  } as OrcaRuntimeService
}

describe('terminal input queue RPC', () => {
  it('acknowledges duplicate mobile input without writing it twice', async () => {
    const replies: string[] = []
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 3
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const request = makeRequest({
      terminal: 'terminal-1',
      text: 'さ',
      client: { id: 'mobile-1', type: 'mobile' },
      inputQueue: { id: 'queue-1', sequence: 1 }
    })

    await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), {
      clientId: 'mobile-1'
    })
    await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), {
      clientId: 'mobile-1'
    })

    expect(runtime.sendTerminal).toHaveBeenCalledOnce()
    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: true,
        result: {
          send: expect.objectContaining({
            accepted: true,
            inputQueue: { id: 'queue-1', sequence: 1 }
          })
        }
      }),
      expect.objectContaining({
        ok: true,
        result: {
          send: expect.objectContaining({
            accepted: true,
            inputQueue: { id: 'queue-1', sequence: 1 }
          })
        }
      })
    ])
  })

  it('rejects an identity that does not match the authenticated mobile', async () => {
    const replies: string[] = []
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest({
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'spoofed-mobile', type: 'mobile' },
        inputQueue: { id: 'queue-1', sequence: 1 }
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

  it('stores a bounded fingerprint instead of retaining the input payload', async () => {
    const runTerminalInputQueueOperation = vi.fn(
      async (_client, _queue, _sequence, _fingerprint, operation) => operation()
    )
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      runTerminalInputQueueOperation,
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 1_000
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest({
        terminal: 'terminal-1',
        text: 'x'.repeat(1_000),
        client: { id: 'mobile-1', type: 'mobile' },
        inputQueue: { id: 'queue-1', sequence: 1 }
      }),
      () => {},
      { clientId: 'mobile-1' }
    )

    expect(runTerminalInputQueueOperation.mock.calls[0]?.[3]).toMatch(/^[a-f0-9]{64}$/)
  })

  it('advertises acknowledged terminal input queue support', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_INPUT_QUEUE_RUNTIME_CAPABILITY)
  })
})
