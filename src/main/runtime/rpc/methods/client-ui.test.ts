import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('client UI RPC methods', () => {
  it('returns the runtime host persisted UI state', async () => {
    const ui: PersistedUIState = {
      ...getDefaultUIState(),
      groupBy: 'none',
      sortBy: 'smart',
      showActiveOnly: true,
      filterRepoIds: ['repo-1']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getUIState: vi.fn(() => ui)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ui.get'))

    expect(runtime.getUIState).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({ ok: true, result: { ui } })
  })

  it('persists UI updates on the runtime host and returns the updated state', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      showActiveOnly: true,
      filterRepoIds: ['repo-1']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { showActiveOnly: true, filterRepoIds: ['repo-1'] })
    )

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      showActiveOnly: true,
      filterRepoIds: ['repo-1']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })
})
