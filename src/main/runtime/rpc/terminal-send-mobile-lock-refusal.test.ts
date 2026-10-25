import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.send reads only these runtime members.
  return {
    getRuntimeId: () => 'test-runtime',
    beginMobileInputFloor: vi.fn(() => ({ commit: async () => {}, rollback: vi.fn() })),
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal send mobile-lock refusal reason', () => {
  const accepted = { handle: 'terminal-1', accepted: true, bytesWritten: 1 }

  async function send(
    driver: { kind: string; clientId?: string },
    params: Record<string, unknown>,
    overrides: Partial<OrcaRuntimeService> = {}
  ) {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue(driver),
      sendTerminal: vi.fn().mockResolvedValue(accepted),
      ...overrides
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', { terminal: 'terminal-1', ...params })
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return {
      runtime,
      send: z.object({ send: z.record(z.string(), z.unknown()) }).parse(response.result).send
    }
  }

  it.each([
    ['desktop client on a desktop-driven pane', { kind: 'desktop' }, { type: 'desktop' }],
    ['desktop client on an idle pane', { kind: 'idle' }, { type: 'desktop' }],
    ['mobile client on its own pane', { kind: 'mobile', clientId: 'm1' }, { type: 'mobile' }]
  ])('names no reason and writes for a %s', async (_label, driver, client) => {
    const { runtime, send: result } = await send(driver, {
      text: 'x',
      client: { id: 'c1', ...client }
    })
    expect(result).toEqual(accepted)
    expect(runtime.sendTerminal).toHaveBeenCalledTimes(1)
  })

  it('still lets a client that sends no metadata write to a phone-driven pane', async () => {
    const { runtime, send: result } = await send({ kind: 'mobile', clientId: 'm1' }, { text: 'x' })
    expect(result).toEqual(accepted)
    expect(runtime.sendTerminal).toHaveBeenCalledTimes(1)
  })

  it('names the phone for a text-plus-Enter prompt refused by the lock', async () => {
    const { runtime, send: result } = await send(
      { kind: 'mobile', clientId: 'm1' },
      { text: 'hello', enter: true, client: { id: 'orca-cli', type: 'desktop' } }
    )
    expect(result).toEqual({
      handle: 'terminal-1',
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'mobile-driving'
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('does not blame the phone when a guarded send fails because the terminal is gone', async () => {
    const { runtime, send: result } = await send(
      { kind: 'desktop' },
      { enter: true, requireAgentStatus: 'sendable', client: { id: 'c1', type: 'desktop' } },
      { getTerminalAgentStatus: vi.fn().mockRejectedValue(new Error('terminal_gone')) }
    )
    expect(result).toEqual({ handle: 'terminal-1', accepted: false, bytesWritten: 0 })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('keeps the permission reason when a guarded send hits a permission prompt', async () => {
    const { send: result } = await send(
      { kind: 'desktop' },
      { enter: true, requireAgentStatus: 'sendable', client: { id: 'c1', type: 'desktop' } },
      {
        getTerminalAgentStatus: vi.fn().mockResolvedValue({
          handle: 'terminal-1',
          isRunningAgent: true,
          status: 'permission'
        })
      }
    )
    expect(result).toMatchObject({ accepted: false, refusedReason: 'permission' })
  })

  it('gives the phone reason, not a no-agent one, when the lock refuses a guarded send', async () => {
    const { send: result } = await send(
      { kind: 'mobile', clientId: 'm1' },
      { enter: true, requireAgentStatus: 'sendable', client: { id: 'c1', type: 'desktop' } }
    )
    expect(result).toMatchObject({ accepted: false, refusedReason: 'mobile-driving' })
  })
})
