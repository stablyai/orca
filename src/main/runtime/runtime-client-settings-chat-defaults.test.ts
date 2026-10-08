import { expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { RuntimeClientSettingsController } from './runtime-client-settings'

it('publishes the existing paired-client chat preferences for explicit launches', () => {
  const settings = createGlobalSettingsFixture({
    nativeChatPermissionMode: 'ask',
    nativeChatSessionOptions: {
      claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'high' } } }
    }
  })
  expect(new RuntimeClientSettingsController({ getSettings: () => settings }).get()).toMatchObject({
    nativeChatPermissionMode: 'ask',
    nativeChatSessionOptions: settings.nativeChatSessionOptions
  })
})
