import { ZH_MANUAL_BROWSER_KEY_OVERRIDES } from './locale-zh-manual-browser-key-overrides.mjs'
import { ZH_MANUAL_COLLABORATION_KEY_OVERRIDES } from './locale-zh-manual-collaboration-key-overrides.mjs'
import { ZH_MANUAL_INTERPOLATED_COPY_KEY_OVERRIDES } from './locale-zh-manual-interpolated-copy-key-overrides.mjs'
import { ZH_MANUAL_PRODUCT_SURFACE_KEY_OVERRIDES } from './locale-zh-manual-product-surface-key-overrides.mjs'
import { ZH_MANUAL_SETTINGS_KEY_OVERRIDES } from './locale-zh-manual-settings-key-overrides.mjs'
import { ZH_MANUAL_WORKSPACE_KEY_OVERRIDES } from './locale-zh-manual-workspace-key-overrides.mjs'

// Human-reviewed full-key copy is authoritative and must not pass through generic MT repairs.
export const ZH_HUMAN_KEY_OVERRIDES = {
  ...ZH_MANUAL_BROWSER_KEY_OVERRIDES,
  ...ZH_MANUAL_COLLABORATION_KEY_OVERRIDES,
  ...ZH_MANUAL_INTERPOLATED_COPY_KEY_OVERRIDES,
  ...ZH_MANUAL_PRODUCT_SURFACE_KEY_OVERRIDES,
  ...ZH_MANUAL_SETTINGS_KEY_OVERRIDES,
  ...ZH_MANUAL_WORKSPACE_KEY_OVERRIDES
}
