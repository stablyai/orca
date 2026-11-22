import type { RuntimeCapability } from '../../../shared/remote-runtime/protocol/protocol-version'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../../shared/workspace-layout/published-layout/layout-intents-capability'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../../shared/worktree/metadata/workspace-unread-raise-capability'
import { MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'

export function darkSwitchRuntimeCapabilities(): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = []
  // Switch point: e2e simulates older unread hosts without retaining an old binary.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN && process.env.ORCA_E2E_OLDER_UNREAD_HOST !== '1') {
    capabilities.push(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
  }
  // Switch point: relayed servers' row notices come from the paired-server rows watch, built only here.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    capabilities.push(MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY)
  }
  // Switch point: paired desktops may submit layout intents (layout-intents-capability.ts).
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    capabilities.push(LAYOUT_INTENTS_RUNTIME_CAPABILITY, LAYOUT_REOPEN_HELD_PANES_CAPABILITY)
  }
  return capabilities
}
