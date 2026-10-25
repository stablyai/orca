import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getDefaultSourceControlAiSettings } from '../../shared/source-control-ai'

// settings.get is an allowlist: omitted per-action agent recipes look unsaved to paired AI buttons.
function projectionOf(settings: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() reads nothing but store.getSettings(); every other RuntimeStore member is unreachable from that path.
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

function hostSettings(sourceControlAi: GlobalSettings['sourceControlAi']): Partial<GlobalSettings> {
  return { ...createGlobalSettingsFixture({ workspaceDir: '/w' }), sourceControlAi }
}

describe('RuntimeClientSettingsController source control launch recipes', () => {
  it('publishes the recipe saved for a launch action', () => {
    const projected = projectionOf(
      hostSettings({
        ...getDefaultSourceControlAiSettings(),
        actions: { fixChecks: { agentId: 'codex', agentArgs: '--fast' } }
      })
    )
    expect(projected.sourceControlAi.actions.fixChecks).toMatchObject({
      agentId: 'codex',
      agentArgs: '--fast'
    })
  })

  it('publishes a recipe saved under the legacy launch defaults key', () => {
    const projected = projectionOf(
      hostSettings({
        ...getDefaultSourceControlAiSettings(),
        actions: undefined,
        launchActionDefaults: { resolveConflicts: { agentId: 'claude' } }
      })
    )
    expect(projected.sourceControlAi.actions.resolveConflicts).toMatchObject({ agentId: 'claude' })
  })

  it('publishes launch actions only, not the text generation recipes', () => {
    const projected = projectionOf(hostSettings(getDefaultSourceControlAiSettings()))
    expect(Object.keys(projected.sourceControlAi.actions).sort()).toEqual([
      'fixChecks',
      'fixCommitFailure',
      'fixPushFailure',
      'resolveComments',
      'resolveConflicts'
    ])
  })
})
