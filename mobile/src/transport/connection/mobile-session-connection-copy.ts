import type { ConnectionState } from './connection-state'
import type { Translate } from '../../i18n/mobile-i18n'

export function mobileSessionStatusLabel(state: ConnectionState, t: Translate): string {
  switch (state) {
    case 'connecting':
      return t('session.routeHelpers.connecting', 'Connecting')
    case 'handshaking':
      return t('session.routeHelpers.securing', 'Securing')
    case 'connected':
      return t('session.routeHelpers.connected', 'Connected')
    case 'disconnected':
      return t('session.routeHelpers.disconnected', 'Disconnected')
    case 'reconnecting':
      return t('session.routeHelpers.reconnecting', 'Reconnecting')
    case 'auth-failed':
      return t('session.routeHelpers.pairingInvalid', 'Pairing invalid')
  }
}
