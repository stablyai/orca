import { ZH_MANUAL_SETTINGS_CORE_KEY_OVERRIDES } from './locale-zh-manual-settings-core-key-overrides.mjs'
import { ZH_MANUAL_SETTINGS_CROSS_SURFACE_KEY_OVERRIDES } from './locale-zh-manual-settings-cross-surface-key-overrides.mjs'
import { ZH_MANUAL_SETTINGS_ONBOARDING_MOBILE_KEY_OVERRIDES } from './locale-zh-manual-settings-onboarding-mobile-key-overrides.mjs'

// Keep the public settings override export stable while domain modules stay below lint limits.
export const ZH_MANUAL_SETTINGS_KEY_OVERRIDES = {
  ...ZH_MANUAL_SETTINGS_CORE_KEY_OVERRIDES,
  ...ZH_MANUAL_SETTINGS_ONBOARDING_MOBILE_KEY_OVERRIDES,
  ...ZH_MANUAL_SETTINGS_CROSS_SURFACE_KEY_OVERRIDES
}
