import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { NOTIFICATION_METHODS } from './notifications'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function resultOf(response: RpcResponse): unknown {
  if ('error' in response && response.error) {
    throw new Error(`RPC failed: ${JSON.stringify(response.error)}`)
  }
  return (response as { result: unknown }).result
}

describe('notifications.dispatch RPC method', () => {
  it('resolves a terminal handle to a worktree + pane key and fires the notification', async () => {
    const dispatchNotification = vi.fn().mockResolvedValue({ delivered: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showTerminal: vi.fn().mockResolvedValue({
        handle: 'term_abc',
        worktreeId: 'repo::wt1',
        tabId: 'tab-9',
        leafId: LEAF_ID
      }),
      resolveActiveTerminal: vi.fn(),
      dispatchNotification
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTIFICATION_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('notifications.dispatch', {
        terminal: 'term_abc',
        title: 'Blocked',
        message: 'Needs your input'
      })
    )

    expect(runtime.resolveActiveTerminal).not.toHaveBeenCalled()
    expect(dispatchNotification).toHaveBeenCalledWith({
      source: 'dispatch',
      message: 'Needs your input',
      title: 'Blocked',
      worktreeId: 'repo::wt1',
      paneKey: `tab-9:${LEAF_ID}`
    })
    expect(resultOf(response)).toEqual({
      dispatch: { delivered: true, worktreeId: 'repo::wt1', paneKey: `tab-9:${LEAF_ID}` }
    })
  })

  it('falls back to the active terminal in the selected worktree', async () => {
    const dispatchNotification = vi.fn().mockResolvedValue({ delivered: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveActiveTerminal: vi.fn().mockResolvedValue('term_active'),
      showTerminal: vi.fn().mockResolvedValue({
        handle: 'term_active',
        worktreeId: 'repo::wt2',
        tabId: 'tab-3',
        leafId: LEAF_ID
      }),
      dispatchNotification
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTIFICATION_METHODS })

    await dispatcher.dispatch(
      makeRequest('notifications.dispatch', { worktree: 'active', message: 'Done' })
    )

    expect(runtime.resolveActiveTerminal).toHaveBeenCalledWith('active')
    expect(dispatchNotification).toHaveBeenCalledWith({
      source: 'dispatch',
      message: 'Done',
      worktreeId: 'repo::wt2',
      paneKey: `tab-3:${LEAF_ID}`
    })
  })

  it('still fires a plain notification when no terminal can be resolved', async () => {
    const dispatchNotification = vi.fn().mockResolvedValue({ delivered: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveActiveTerminal: vi.fn().mockRejectedValue(new Error('no_active_terminal')),
      showTerminal: vi.fn(),
      dispatchNotification
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTIFICATION_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('notifications.dispatch', { message: 'Heads up' })
    )

    expect(dispatchNotification).toHaveBeenCalledWith({ source: 'dispatch', message: 'Heads up' })
    expect(resultOf(response)).toEqual({ dispatch: { delivered: true } })
  })

  it('surfaces the resolution error when an explicit target cannot be found', async () => {
    const dispatchNotification = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveActiveTerminal: vi.fn(),
      showTerminal: vi.fn().mockRejectedValue(new Error('terminal_not_found')),
      dispatchNotification
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTIFICATION_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('notifications.dispatch', { terminal: 'term_missing', message: 'hi' })
    )

    expect(dispatchNotification).not.toHaveBeenCalled()
    expect('error' in response && response.error).toBeTruthy()
  })

  it('rejects a dispatch without a message', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dispatchNotification: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTIFICATION_METHODS })

    const response = await dispatcher.dispatch(makeRequest('notifications.dispatch', {}))
    expect('error' in response && response.error).toBeTruthy()
    expect(runtime.dispatchNotification).not.toHaveBeenCalled()
  })
})
