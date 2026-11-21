import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { RuntimeClientSettingsController } from './runtime-client-settings'

vi.mock('../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

function nativeChatDefaults(headless: boolean, settings: Partial<GlobalSettings> = {}) {
  const stored = { ...getDefaultSettings('/home/user'), ...settings }
  const controller = new RuntimeClientSettingsController(
    { getSettings: () => stored, updateSettings: () => {}, runDurableMutation: vi.fn() },
    undefined,
    undefined,
    () => headless
  )
  return controller.get().nativeChatDefaults
}

it('reports no choice for a headless host nobody set Chat or CLI on', () => {
  expect(nativeChatDefaults(true)).toBeNull()
})

it("reports a headless host's saved per-agent choice", () => {
  expect(nativeChatDefaults(true, { nativeChatProviders: { pi: false } })).toEqual({
    agentDefaultSurface: 'terminal',
    nativeChatProviders: { pi: false }
  })
})

it("reports a desktop's untouched CLI default as its choice", () => {
  expect(nativeChatDefaults(false)).toEqual({
    agentDefaultSurface: 'terminal',
    nativeChatProviders: {}
  })
})

it("reports a headless host's Terminal once a paired client chose it", async () => {
  let stored: GlobalSettings = getDefaultSettings('/home/user')
  const controller = new RuntimeClientSettingsController(
    {
      getSettings: () => stored,
      updateSettings: (updates: Partial<GlobalSettings>) => {
        stored = { ...stored, ...updates }
      },
      runDurableMutation: vi.fn()
    },
    undefined,
    undefined,
    () => true
  )

  await controller.update({ agentDefaultSurface: 'terminal' })

  expect(controller.get().nativeChatDefaults).toEqual({
    agentDefaultSurface: 'terminal',
    nativeChatProviders: {}
  })
})
