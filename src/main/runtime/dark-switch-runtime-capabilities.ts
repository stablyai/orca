import type { RuntimeCapability } from '../../shared/protocol-version'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../shared/workspace-layout/layout-intents-capability'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../shared/workspace-unread-raise-capability'

export function darkSwitchRuntimeCapabilities(): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = []
  // Switch point: e2e simulates older unread hosts without retaining an old binary.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN && process.env.ORCA_E2E_OLDER_UNREAD_HOST !== '1') {
    capabilities.push(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
  }
  // Switch point: paired desktops may submit layout intents (layout-intents-capability.ts).
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    capabilities.push(LAYOUT_INTENTS_RUNTIME_CAPABILITY, LAYOUT_REOPEN_HELD_PANES_CAPABILITY)
  }
  return capabilities
}
