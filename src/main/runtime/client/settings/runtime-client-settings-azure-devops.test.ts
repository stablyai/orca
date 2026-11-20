import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { CLIENT_UI_METHODS } from '../../rpc/methods/client-state/client-ui'
import { RuntimeClientSettingsController } from './runtime-client-settings'

vi.mock('../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

it('round-trips the Azure DevOps method on the paired host and rejects unsupported methods', async () => {
  let stored: GlobalSettings = getDefaultSettings('/home/user')
  const settings = new RuntimeClientSettingsController({
    getSettings: () => stored,
    updateSettings: (updates) => {
      stored = { ...stored, ...updates }
    }
  })
  const server = {
    getRuntimeId: () => 'server-runtime',
    getClientSettings: () => settings.get(),
    updateClientSettings: (updates: Parameters<typeof settings.update>[0]) =>
      settings.update(updates)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.get/update read only the members above.
  const runtime = server as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  let requestId = 0
  const call = (method: string, params?: unknown) =>
    dispatcher.dispatch(
      { id: `req-${++requestId}`, authToken: 'tok', method, params },
      { clientKind: 'mobile' }
    )

  await expect(
    call('settings.update', { azureDevOpsAuthMethod: 'azure-cli' })
  ).resolves.toMatchObject({
    ok: true,
    result: { settings: { azureDevOpsAuthMethod: 'azure-cli' } }
  })
  await expect(
    call('settings.update', { azureDevOpsAuthMethod: 'automatic' })
  ).resolves.toMatchObject({ ok: false })
  await expect(call('settings.get')).resolves.toMatchObject({
    ok: true,
    result: { settings: { azureDevOpsAuthMethod: 'azure-cli' } }
  })
})
