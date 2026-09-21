import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  AgentSessionPtyWriteRefusedError,
  type AgentSessionPtyWriteRefusal
} from '../../../shared/agent-session-pty-write-admission'

// terminal.send is the one write path a paired client can reach, so a lease refusal has to arrive
// as a result it can render — not as a transport error and not as a silent `accepted: false`.

const REFUSAL: AgentSessionPtyWriteRefusal = {
  code: 'agent_session_conflict',
  sessionId: 'session-alpha-1',
  ownerRuntimeKind: 'native',
  handoffStage: 'preparing',
  ownerPid: 4242,
  runtimeFence: 7
}

const rollback = vi.fn()

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    beginMobileInputFloor: vi.fn(() => ({ commit: async () => {}, rollback })),
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.send', params }
}

async function send(runtime: OrcaRuntimeService, client: { id: string; type: string }) {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  return await dispatcher.dispatch(makeRequest({ terminal: 'terminal-1', text: 'hello', client }))
}

describe('terminal.send under a refusing lease', () => {
  it('returns the typed refusal instead of failing the call', async () => {
    const runtime = stubRuntime({
      sendTerminal: vi.fn().mockRejectedValue(new AgentSessionPtyWriteRefusedError(REFUSAL))
    })

    const response = await send(runtime, { id: 'desktop-1', type: 'desktop' })

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0,
        agentSessionRefusal: REFUSAL
      }
    })
  })

  it('keeps the refusal additive so an old client still reads accepted: false', async () => {
    const runtime = stubRuntime({
      sendTerminal: vi.fn().mockRejectedValue(new AgentSessionPtyWriteRefusedError(REFUSAL))
    })

    const response = await send(runtime, { id: 'desktop-1', type: 'desktop' })

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const result = response.result as { send: { accepted: boolean; refusedReason?: string } }
    expect(result.send.accepted).toBe(false)
    // A new `refusedReason` value would reach old clients as an unknown enum member.
    expect(result.send.refusedReason).toBeUndefined()
  })

  it('releases the mobile input floor a refused send never used', async () => {
    rollback.mockClear()
    const runtime = stubRuntime({
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        options?.reserveWrite?.('pty-1')
        throw new AgentSessionPtyWriteRefusedError(REFUSAL)
      })
    })

    await send(runtime, { id: 'mobile-1', type: 'mobile' })

    expect(rollback).toHaveBeenCalled()
  })

  it('still surfaces unrelated send failures as errors', async () => {
    const runtime = stubRuntime({
      sendTerminal: vi.fn().mockRejectedValue(new Error('terminal_not_writable'))
    })

    const response = await send(runtime, { id: 'desktop-1', type: 'desktop' })

    expect(response.ok).toBe(false)
  })
})
