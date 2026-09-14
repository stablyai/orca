import { expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { normalizeWorkspaceMultiplexerState } from '../../../../shared/workspace-multiplexer-types'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

it('removes only the selected slot, preserves saved layouts and runtime state, and is idempotent', async () => {
  const layout = normalizeWorkspaceMultiplexerState({
    slots: [
      { id: 'local', worktreeId: 'same', executionHostId: 'local' },
      { id: 'ssh', worktreeId: 'same', executionHostId: 'ssh:dev' },
      { id: 'folder', worktreeId: 'folder:test', executionHostId: 'local' }
    ],
    layout: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.65,
      first: { type: 'leaf', groupId: 'local' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', groupId: 'folder' },
        second: { type: 'leaf', groupId: 'ssh' }
      }
    }
  })
  let ui = {
    ...getDefaultUIState(),
    activeView: 'multiplexer' as const,
    workspaceMultiplexer: normalizeWorkspaceMultiplexerState({
      ...layout,
      activeLayoutId: 'active',
      savedLayouts: [
        { id: 'active', name: 'Active', layout },
        { id: 'other', name: 'Other', layout }
      ]
    })
  }
  const updateUIState = vi.fn((updates: Partial<PersistedUIState>) => {
    ui = { ...ui, ...updates } as typeof ui
    return ui
  })
  const runtime = {
    getRuntimeId: () => 'runtime',
    getUIState: () => ui,
    updateUIState
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  const call = (method: string, params?: unknown) =>
    dispatcher.dispatch({ id: 'test', authToken: 'test', method, params })
  expect(await call('multiplexer.list')).toMatchObject({
    ok: true,
    result: { multiplexer: { slots: layout.slots } }
  })
  expect(await call('multiplexer.remove', { slotId: 'local' })).toMatchObject({
    ok: true,
    result: { removed: true }
  })
  expect(ui.workspaceMultiplexer.slots.map((s) => s.id)).toEqual(['ssh', 'folder'])
  expect(ui.workspaceMultiplexer.layout).toEqual(
    layout.layout?.type === 'split' ? layout.layout.second : undefined
  )
  expect(ui.workspaceMultiplexer.savedLayouts![1]!.layout).toEqual(layout)
  expect(ui.activeView).toBe('multiplexer')
  expect(Object.keys(updateUIState.mock.calls[0]![0])).toEqual(['workspaceMultiplexer'])
  expect(await call('multiplexer.remove', { slotId: 'local' })).toMatchObject({
    ok: true,
    result: { removed: false }
  })
  expect(updateUIState).toHaveBeenCalledOnce()
  expect(await call('multiplexer.remove', { slotId: '' })).toMatchObject({ ok: false })
})
