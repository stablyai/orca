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
      'Update it with its package manager or service manager.'
    )
  }
  if (support.reason === 'unpackaged-build') {
    return t('host.edit.updateStepsSourceCheckout', 'Update it from its source checkout.')
  }
  return t('host.edit.updateStepsServer', 'Update Orca on the server, then restart it.')
}
