import type { RuntimeCapability } from '../../shared/protocol-version'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../shared/workspace-layout/layout-intents-capability'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../shared/workspace-unread-raise-capability'

/** What this host advertises because a dark build switch is on. */
export function darkSwitchRuntimeCapabilities(): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = []
  // Switch point: this host raises the workspace unread flag itself. The env lets the e2e play an
  // older host without keeping an old binary.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN && process.env.ORCA_E2E_OLDER_UNREAD_HOST !== '1') {
    capabilities.push(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
  }
  // Switch point: main here takes a paired desktop's layout intents (layout-intents-capability.ts).
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    capabilities.push(LAYOUT_INTENTS_RUNTIME_CAPABILITY, LAYOUT_REOPEN_HELD_PANES_CAPABILITY)
  }
  return capabilities
}
