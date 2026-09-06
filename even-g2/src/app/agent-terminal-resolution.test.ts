import { describe, expect, it, vi } from 'vitest'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'
import {
  resolveActiveTerminalHandle,
  resolveWaitingTerminalHandle
} from './agent-terminal-resolution'

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

function ok(result: unknown): RpcResponse {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
}

describe('resolveWaitingTerminalHandle (CRITICAL #10)', () => {
  function fakePortFor(
    terminals: { handle: string }[],
    statesByHandle: Record<string, string>
  ): RpcPort {
    const sendRequest = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      if (method === 'terminal.list') {
        return ok({ terminals })
      }
      const handle = (params as { terminal: string }).terminal
      return ok({ agentStatus: { state: statesByHandle[handle] } })
    })
    return { sendRequest, subscribe: vi.fn() }
  }

  it('returns the unique terminal whose agentStatus is waiting', async () => {
    const port = fakePortFor([{ handle: 't1' }, { handle: 't2' }], { t1: 'working', t2: 'waiting' })
    expect(await resolveWaitingTerminalHandle(port, 'wt-1')).toEqual({ handle: 't2' })
  })

  it('treats "blocked" as needing input too', async () => {
    const port = fakePortFor([{ handle: 't1' }], { t1: 'blocked' })
    expect(await resolveWaitingTerminalHandle(port, 'wt-1')).toEqual({ handle: 't1' })
  })

  it('fails closed (none) when no terminal is waiting', async () => {
    const port = fakePortFor([{ handle: 't1' }], { t1: 'working' })
    expect(await resolveWaitingTerminalHandle(port, 'wt-1')).toEqual({ none: true })
  })

  it('fails closed (none) when the worktree has no terminals', async () => {
    const port = fakePortFor([], {})
    expect(await resolveWaitingTerminalHandle(port, 'wt-1')).toEqual({ none: true })
  })

  it('fails closed (ambiguous) when more than one terminal is waiting — never guesses', async () => {
    const port = fakePortFor([{ handle: 't1' }, { handle: 't2' }], { t1: 'waiting', t2: 'blocked' })
    expect(await resolveWaitingTerminalHandle(port, 'wt-1')).toEqual({ ambiguous: true })
  })

  it('fails closed (none) when terminal.list itself fails', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: false,
      error: { code: 'boom', message: 'boom' },
      _meta: { runtimeId: 'r' }
    }))
    expect(await resolveWaitingTerminalHandle(fakePort(sendRequest), 'wt-1')).toEqual({
      none: true
    })
  })

  it('excludes (never guesses) a terminal whose individual agentStatus probe fails', async () => {
    const sendRequest = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      if (method === 'terminal.list') {
        return ok({ terminals: [{ handle: 't1' }, { handle: 't2' }] })
      }
      const handle = (params as { terminal: string }).terminal
      if (handle === 't1') {
        throw new Error('socket closed mid-request')
      }
      return ok({ agentStatus: { state: 'waiting' } })
    })
    expect(await resolveWaitingTerminalHandle({ sendRequest, subscribe: vi.fn() }, 'wt-1')).toEqual(
      { handle: 't2' }
    )
  })
})
