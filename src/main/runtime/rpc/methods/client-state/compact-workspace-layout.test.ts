import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { z } from 'zod'
import { getWorktreeCardModeUpdates } from '../../../../../shared/worktree/card-properties'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import { RpcDispatcher } from '../../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

vi.mock('electron', () => ({ app: { getPath: () => '/orca-state', isPackaged: true } }))
vi.mock('../../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

function runtime() {
  let settings = getDefaultSettings('/tmp')
  return new OrcaRuntimeService(
    partialRuntimeStore({
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => {
        settings = { ...settings, ...updates }
      }
    })
  )
}

it('round-trips compact-header selection and clearing through paired settings RPC', async () => {
  const dispatcher = new RpcDispatcher({ runtime: runtime(), methods: CLIENT_UI_METHODS })
  expect(
    await dispatcher.dispatch({
      id: 'select',
      authToken: 'tok',
      method: 'settings.update',
      params: getWorktreeCardModeUpdates('CompactHeader').settings
    })
  ).toMatchObject({
    ok: true,
    result: { settings: { compactWorktreeHeader: true, compactWorktreeCards: false } }
  })
  expect(
    await dispatcher.dispatch({ id: 'read', authToken: 'tok', method: 'settings.get' })
  ).toMatchObject({ ok: true, result: { settings: { compactWorktreeHeader: true } } })
  expect(
    await dispatcher.dispatch({
      id: 'clear',
      authToken: 'tok',
      method: 'settings.update',
      params: getWorktreeCardModeUpdates('Default', { compactWorktreeHeader: true }).settings
    })
  ).toMatchObject({ ok: true, result: { settings: { compactWorktreeHeader: false } } })
})

it('keeps both existing layouts writable to an older strict host', async () => {
  const methods = CLIENT_UI_METHODS.map((method) =>
    method.name === 'settings.update'
      ? { ...method, params: z.object({ compactWorktreeCards: z.boolean().optional() }).strict() }
      : method
  )
  const dispatcher = new RpcDispatcher({ runtime: runtime(), methods })
  expect(
    await dispatcher.dispatch({
      id: 'compact',
      authToken: 'tok',
      method: 'settings.update',
      params: getWorktreeCardModeUpdates('Compact').settings
    })
  ).toMatchObject({ ok: true, result: { settings: { compactWorktreeCards: true } } })
  expect(
    await dispatcher.dispatch({
      id: 'detailed',
      authToken: 'tok',
      method: 'settings.update',
      params: getWorktreeCardModeUpdates('Default').settings
    })
  ).toMatchObject({ ok: true, result: { settings: { compactWorktreeCards: false } } })
})

it('lets an older client leave a compact header using its existing layout picker', async () => {
  const dispatcher = new RpcDispatcher({ runtime: runtime(), methods: CLIENT_UI_METHODS })
  await dispatcher.dispatch({
    id: 'header',
    authToken: 'tok',
    method: 'settings.update',
    params: { compactWorktreeCards: false, compactWorktreeHeader: true }
  })
  expect(
    await dispatcher.dispatch({
      id: 'old-client',
      authToken: 'tok',
      method: 'settings.update',
      params: { compactWorktreeCards: true }
    })
  ).toMatchObject({
    ok: true,
    result: { settings: { compactWorktreeCards: true, compactWorktreeHeader: false } }
  })
})
