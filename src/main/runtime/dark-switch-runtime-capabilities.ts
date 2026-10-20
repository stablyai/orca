import type { RuntimeCapability } from '../../shared/protocol-version'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../shared/workspace-layout/layout-intents-capability'

/** What this host advertises because a dark build switch is on. */
export function darkSwitchRuntimeCapabilities(): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = []
  // Switch point: main here takes a paired desktop's layout intents (layout-intents-capability.ts).
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    capabilities.push(LAYOUT_INTENTS_RUNTIME_CAPABILITY)
  }
  return capabilities
}
