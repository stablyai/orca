import { ZH_MANUAL_SOURCE_CONTROL_KEY_OVERRIDES } from './locale-zh-manual-source-control-key-overrides.mjs'
import { ZH_MANUAL_EDITOR_KEY_OVERRIDES } from './locale-zh-manual-editor-key-overrides.mjs'
import { ZH_MANUAL_WORK_ITEM_KEY_OVERRIDES } from './locale-zh-manual-work-item-key-overrides.mjs'
import { ZH_MANUAL_USAGE_ANALYTICS_KEY_OVERRIDES } from './locale-zh-manual-usage-analytics-key-overrides.mjs'
import { ZH_MANUAL_AUTOMATION_KEY_OVERRIDES } from './locale-zh-manual-automation-key-overrides.mjs'
import { ZH_MANUAL_ACTIVITY_SKILLS_REPOSITORY_WORKSPACE_CRASH_KEY_OVERRIDES } from './locale-zh-manual-activity-skills-repository-workspace-crash-key-overrides.mjs'
import { ZH_MANUAL_RUNTIME_CLIENT_KEY_OVERRIDES } from './locale-zh-manual-runtime-client-key-overrides.mjs'
import { ZH_MANUAL_APP_SHELL_KEY_OVERRIDES } from './locale-zh-manual-app-shell-key-overrides.mjs'
import { ZH_MANUAL_MOBILE_EMULATOR_KEY_OVERRIDES } from './locale-zh-manual-mobile-emulator-key-overrides.mjs'

// Human-reviewed Simplified Chinese overrides grouped by product domain.
// Why: key-level context avoids corrupting code tokens through broad phrase replacement.
export const ZH_MANUAL_PRODUCT_SURFACE_KEY_OVERRIDES = {
  ...ZH_MANUAL_SOURCE_CONTROL_KEY_OVERRIDES,
  ...ZH_MANUAL_EDITOR_KEY_OVERRIDES,
  ...ZH_MANUAL_WORK_ITEM_KEY_OVERRIDES,
  ...ZH_MANUAL_USAGE_ANALYTICS_KEY_OVERRIDES,
  ...ZH_MANUAL_AUTOMATION_KEY_OVERRIDES,
  ...ZH_MANUAL_ACTIVITY_SKILLS_REPOSITORY_WORKSPACE_CRASH_KEY_OVERRIDES,
  ...ZH_MANUAL_RUNTIME_CLIENT_KEY_OVERRIDES,
  ...ZH_MANUAL_APP_SHELL_KEY_OVERRIDES,
  ...ZH_MANUAL_MOBILE_EMULATOR_KEY_OVERRIDES
}
