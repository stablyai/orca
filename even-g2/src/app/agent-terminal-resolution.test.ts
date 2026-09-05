import { describe, expect, it, vi } from 'vitest'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'
import { resolveActiveTerminalHandle } from './agent-terminal-resolution'

function fakePort(sendRequest: RpcPort['sendRequest']): RpcPort {
  return { sendRequest, subscribe: vi.fn() }
}

describe('resolveActiveTerminalHandle', () => {
  it('sends terminal.resolveActive with the id: worktree selector', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: true,
      result: { handle: 'term-1' },
      _meta: { runtimeId: 'r' }
    }))
    const handle = await resolveActiveTerminalHandle(fakePort(sendRequest), 'wt-1')
    expect(handle).toBe('term-1')
    expect(sendRequest).toHaveBeenCalledWith('terminal.resolveActive', { worktree: 'id:wt-1' })
  })

  it('fails closed (returns null) when the host reports no active terminal', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: true,
      result: { handle: null },
      _meta: { runtimeId: 'r' }
    }))
    expect(await resolveActiveTerminalHandle(fakePort(sendRequest), 'wt-1')).toBeNull()
  })

  it('fails closed when the RPC itself fails', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: false,
      error: { code: 'internal', message: 'boom' },
      _meta: { runtimeId: 'r' }
    }))
    expect(await resolveActiveTerminalHandle(fakePort(sendRequest), 'wt-1')).toBeNull()
  })

  it('fails closed when handle is missing from the result', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'r' }
    }))
    expect(await resolveActiveTerminalHandle(fakePort(sendRequest), 'wt-1')).toBeNull()
  })
})
