import { REMOTE_SERVER_UPDATE_CAPABILITY } from '../../../src/shared/remote-runtime/host-catalog/remote-server-update'
import type { Translate } from '../i18n/mobile-i18n'
import type { HostUpdateSupport } from '../transport/connection/host-status-gates'

// Desktops update through their own app, and servers a client can update need no steps.
export function hostManualUpdateSteps(
  support: HostUpdateSupport | undefined,
  capabilities: readonly string[],
  t: Translate
): string | null {
  if (!support || support.installMode === 'interactive') {
    return null
  }
  if (support.automatic && capabilities.includes(REMOTE_SERVER_UPDATE_CAPABILITY)) {
    return null
  }
  if (support.reason === 'manual-service-update-required') {
    return t(
      'host.edit.updateStepsServiceManager',
      "This server can't update itself. Update Orca on it with its package manager if it came from a .deb or .rpm, otherwise through the service manager that starts it."
    )
  }
  if (support.reason === 'unpackaged-build') {
    return t(
      'host.edit.updateStepsSourceCheckout',
      'This is a development build. Update it from its source checkout.'
    )
  }
  return t(
    'host.edit.updateStepsServer',
    "This server can't update itself. Update Orca on the server computer, then restart the server."
  )
}
