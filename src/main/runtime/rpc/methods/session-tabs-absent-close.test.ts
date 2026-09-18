import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab absent close RPC methods', () => {
  it('propagates selector_not_found when runtime throws selector_not_found', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock runtime service for unit test
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      closeMobileSessionTab: vi.fn().mockRejectedValue(new Error('selector_not_found'))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const base = { worktree: 'id:wt-1', tabId: 'tab-1' }
    const lifecycle = { reason: 'pty-exit', publicationEpoch: 'epoch-1', terminal: 'term-1' }
    for (const [method, extra] of [
      ['session.tabs.close', { reason: 'user' }],
      ['session.tabs.closeLifecycle', lifecycle]
    ] as const) {
      const res = await dispatcher.dispatch(makeRequest(method, { ...base, ...extra }))
      expect(res.ok).toBe(false)
      expect(res).toMatchObject({
        error: { message: 'selector_not_found' }
      })
    }
  })
})
