import type { ConnectionState } from './connection-state'
import { translate } from '../../i18n/mobile-i18n'

export const MOBILE_SESSION_STATUS_LABELS: Record<ConnectionState, string> = {
  get connecting() {
    return translate('session.routeHelpers.connecting', 'Connecting')
  },
  get handshaking() {
    return translate('session.routeHelpers.securing', 'Securing')
  },
  get connected() {
    return translate('session.routeHelpers.connected', 'Connected')
  },
  get disconnected() {
    return translate('session.routeHelpers.disconnected', 'Disconnected')
  },
  get reconnecting() {
    return translate('session.routeHelpers.reconnecting', 'Reconnecting')
  },
  get 'auth-failed'() {
    return translate('session.routeHelpers.pairingInvalid', 'Pairing invalid')
  }
}
