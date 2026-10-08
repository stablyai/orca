import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'

describe('RuntimeClientSettingsController native chat graduation cohort', () => {
  // Why: paired and web clients must fail closed, so the host never publishes the marker.
  it('never projects the cohort marker to paired clients', () => {
    const settings = {
      ...createGlobalSettingsFixture({ workspaceDir: '/w' }),
      nativeChatGraduationCohort: 'experimental-opt-in' as const
    }
    const projection = new RuntimeClientSettingsController({
      getSettings: () => settings,
      updateSettings: () => settings
    }).get()

    expect(Object.keys(projection)).not.toContain('nativeChatGraduationCohort')
  })
})
