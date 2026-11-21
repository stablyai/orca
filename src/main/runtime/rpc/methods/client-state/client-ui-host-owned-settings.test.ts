import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { RuntimeClientSettingsController } from '../../../client/settings/runtime-client-settings'
import { CLIENT_UI_METHODS } from './client-ui'

vi.mock('../../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

function makeHost() {
  let stored: GlobalSettings = getDefaultSettings('/home/user')
  const controller = new RuntimeClientSettingsController({
    getSettings: () => stored,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      stored = { ...stored, ...updates }
    },
    runDurableMutation: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the settings methods read only these members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => controller.get(),
    updateClientSettings: (updates: Parameters<typeof controller.update>[0]) =>
      controller.update(updates)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  let id = 0
  const call = (method: string, params?: unknown) =>
    dispatcher.dispatch({ id: `req-${++id}`, authToken: 'tok', method, params }, {})
  return { call, stored: () => stored }
}

it("saves a paired client's branch prefix on the host that names new branches", async () => {
  const host = makeHost()

  expect(
    await host.call('settings.update', { branchPrefix: 'custom', branchPrefixCustom: 'devel' })
  ).toMatchObject({ ok: true })

  expect(host.stored()).toMatchObject({ branchPrefix: 'custom', branchPrefixCustom: 'devel' })
  expect(await host.call('settings.get')).toMatchObject({
    ok: true,
    result: { settings: { branchPrefix: 'custom', branchPrefixCustom: 'devel' } }
  })
})
