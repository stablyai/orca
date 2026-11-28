import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'

describe('RuntimeClientSettingsController.get', () => {
  it('reports a deliberately emptied hidden-agents list as customized', () => {
    const store = {
      getSettings: () => ({ disabledTuiAgents: [], disabledTuiAgentsCustomized: true })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() only reads getSettings.
    const controller = new RuntimeClientSettingsController(store as never)
    expect(controller.get().disabledTuiAgentsCustomized).toBe(true)
  })
})
