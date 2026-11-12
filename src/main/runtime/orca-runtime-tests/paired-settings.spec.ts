import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { applyAgentStatusHooksEnabledMock } from '../orca-runtime-test-mocks/setup.spec'
import { deferred, store } from './orca-runtime-test-fixtures.spec'
import '../client/settings/runtime-client-settings'

describe('OrcaRuntimeService', () => {
  it('serializes paired-client hook reconciliation and reads current settings', async () => {
    let settings = {
      ...store.getSettings(),
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const firstReconciliation = deferred<[]>()
    applyAgentStatusHooksEnabledMock
      .mockImplementationOnce(() => firstReconciliation.promise)
      .mockResolvedValueOnce([])
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    const first = runtime.updateClientSettings({ disabledTuiAgents: ['claude'] })
    await vi.waitFor(() => expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce())
    const second = runtime.updateClientSettings({ disabledTuiAgents: [] })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    const firstOptions = applyAgentStatusHooksEnabledMock.mock.calls[0]?.[2]
    expect(firstOptions?.shouldContinue?.('claude')).toBe(true)

    firstReconciliation.resolve([])
    await Promise.all([first, second])

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledTimes(2)
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ disabledTuiAgents: [] }),
      expect.objectContaining({ shouldContinue: expect.any(Function) })
    )
  })
})
