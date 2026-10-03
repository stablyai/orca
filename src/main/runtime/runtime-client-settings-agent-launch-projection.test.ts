import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

function hostSettings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...createGlobalSettingsFixture({ workspaceDir: '/w' }), ...overrides }
}

function controllerFor(initial: GlobalSettings) {
  let settings = initial
  const store = {
    getSettings: () => settings,
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get()/update() read only getSettings/updateSettings on this path.
  return { controller: new RuntimeClientSettingsController(store as never), store }
}

// Paired clients predate the typed permission mode: they read and write each agent's arguments
// with the permission flag inline. The host keeps that shape at its boundary.
describe('RuntimeClientSettingsController agent launch projection', () => {
  it('publishes launch-ready arguments with the flag inline', () => {
    const { controller } = controllerFor(
      hostSettings({
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: { codex: 'ask' },
        agentDefaultArgs: { claude: '--model opus', codex: '-m o3' },
        agentDefaultEnv: {}
      })
    )

    const published = controller.get()
    expect(published.agentDefaultArgs?.claude).toBe(`${CLAUDE_BYPASS} --model opus`)
    expect(published.agentDefaultArgs?.codex).toBe('-m o3')
    expect(published.agentDefaultEnv?.goose).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('lifts a launch-ready write from an older client into the typed mode', async () => {
    const { controller, store } = controllerFor(
      hostSettings({
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: {},
        agentDefaultArgs: { claude: '', codex: '' },
        agentDefaultEnv: {}
      })
    )

    await controller.update({
      agentDefaultArgs: { claude: '--model opus', codex: `${CODEX_BYPASS} -m o3` }
    })

    expect(store.getSettings().agentPermissionModeOverrides).toEqual({ claude: 'ask' })
    expect(store.getSettings().agentDefaultArgs).toMatchObject({
      claude: '--model opus',
      codex: '-m o3'
    })
    const published = controller.get()
    expect(published.agentDefaultArgs?.claude).toBe('--model opus')
    expect(published.agentDefaultArgs?.codex).toBe(`${CODEX_BYPASS} -m o3`)
  })

  // An older client may not know newer agents; leaving one out must not change it.
  it('leaves agents the written record does not name untouched', async () => {
    const { controller, store } = controllerFor(
      hostSettings({
        agentPermissionMode: 'ask',
        agentPermissionModeOverrides: { gemini: 'bypass' },
        agentDefaultArgs: { claude: '--model opus' },
        agentDefaultEnv: {}
      })
    )

    await controller.update({ agentDefaultArgs: { codex: `${CODEX_BYPASS}` } })

    expect(store.getSettings().agentPermissionModeOverrides).toEqual({
      gemini: 'bypass',
      codex: 'bypass'
    })
    expect(store.getSettings().agentDefaultArgs).toMatchObject({
      claude: '--model opus',
      codex: ''
    })
  })

  it('keeps the mode of an agent whose written text sets permissions itself', async () => {
    const { controller, store } = controllerFor(
      hostSettings({
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: {},
        agentDefaultArgs: { claude: '--permission-mode plan' },
        agentDefaultEnv: {}
      })
    )

    await controller.update({ agentDefaultArgs: controller.get().agentDefaultArgs })

    expect(store.getSettings().agentPermissionModeOverrides?.claude).toBeUndefined()
    expect(controller.get().agentDefaultArgs?.claude).toBe('--permission-mode plan')
  })

  it('keeps the mode of an agent whose written env sets permissions itself', async () => {
    const { controller, store } = controllerFor(
      hostSettings({
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: { goose: { GOOSE_MODE: 'approve' } }
      })
    )

    await controller.update({ agentDefaultEnv: controller.get().agentDefaultEnv })

    expect(store.getSettings().agentPermissionModeOverrides?.goose).toBeUndefined()
    expect(controller.get().agentDefaultEnv?.goose).toEqual({ GOOSE_MODE: 'approve' })
  })

  it('passes other updates through untouched', async () => {
    const { controller, store } = controllerFor(hostSettings({}))

    await controller.update({ machineName: 'box' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { machineName: 'box' },
      { notifyListeners: true }
    )
  })
})
