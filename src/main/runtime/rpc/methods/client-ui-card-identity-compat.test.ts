import { describe, expect, it, vi } from 'vitest'

import { getDefaultUIState } from '../../../../shared/constants'
import {
  RUNTIME_CAPABILITIES,
  WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('client UI card identity compatibility', () => {
  it('projects identity properties away from legacy paired clients', async () => {
    const ui = {
      ...getDefaultUIState(),
      worktreeCardProperties: ['status', 'unread', 'project-name', 'host-name']
    } satisfies PersistedUIState
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getUIState: () => ui
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    let response: unknown

    await dispatcher.dispatchStreaming(
      makeRequest('ui.get'),
      (payload) => {
        response = JSON.parse(payload)
      },
      { clientCapabilities: [] }
    )

    expect(response).toMatchObject({
      ok: true,
      result: { ui: { worktreeCardProperties: ['status', 'unread'] } }
    })
  })

  it('preserves identity properties when a legacy client updates the array', async () => {
    const current = {
      ...getDefaultUIState(),
      worktreeCardProperties: ['status', 'unread', 'project-name']
    } satisfies PersistedUIState
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getUIState: () => current,
      updateUIState: vi.fn((updates: Partial<PersistedUIState>) => ({ ...current, ...updates }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('ui.set', { worktreeCardProperties: ['status', 'pr'] }),
      () => {},
      { clientCapabilities: [] }
    )

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      worktreeCardProperties: ['status', 'unread', 'pr', 'project-name']
    })
  })

  it('advertises identity property support to current paired clients', () => {
    expect(RUNTIME_CAPABILITIES).toContain(WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY)
  })
})
