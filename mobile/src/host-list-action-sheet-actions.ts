import { Activity, Edit3, PowerOff, RefreshCw } from 'lucide-react-native'
import type { ActionSheetAction } from './components/ActionSheetModal'
import type { ConnectionState, HostProfile } from './transport/types'
import { translate } from './i18n/mobile-i18n'

// Defer navigation and new drawers until this native Modal unmounts; presenting into a live one freezes iOS (#8791).
export function getHostListActionSheetActions(args: {
  host: HostProfile | null
  state: ConnectionState
  hasEverConnected: boolean
  onDismiss: () => void
  onReconnect: (hostId: string) => void
  onDisconnect: (hostId: string) => void
  onDiagnostics: (hostId: string) => void
  onEdit: (hostId: string) => void
  onRemove: (host: HostProfile) => void
}): ActionSheetAction[] {
  const { host } = args
  if (!host) {
    return []
  }
  const isLive =
    args.state === 'connected' ||
    args.state === 'connecting' ||
    args.state === 'handshaking' ||
    args.state === 'reconnecting'

  return [
    {
      id: 'connect',
      label:
        args.hasEverConnected && isLive
          ? translate('hostScreen.hostListActionSheetActions.reconnect', 'Reconnect')
          : translate('hostScreen.hostListActionSheetActions.connect', 'Connect'),
      icon: RefreshCw,
      onPress: () => {
        args.onDismiss()
        args.onReconnect(host.id)
      }
    },
    ...(isLive
      ? [
          {
            id: 'disconnect',
            label: translate('hostScreen.hostListActionSheetActions.disconnect', 'Disconnect'),
            icon: PowerOff,
            onPress: () => {
              args.onDismiss()
              args.onDisconnect(host.id)
            }
          }
        ]
      : []),
    {
      id: 'networkDiagnostics',
      label: translate(
        'hostScreen.hostListActionSheetActions.networkDiagnostics',
        'Network diagnostics'
      ),
      icon: Activity,
      closeBeforePress: true,
      onPress: () => {
        args.onDiagnostics(host.id)
      }
    },
    {
      id: 'editHost',
      label: translate('hostScreen.hostListActionSheetActions.editHost', 'Edit host'),
      icon: Edit3,
      closeBeforePress: true,
      onPress: () => {
        args.onDismiss()
        args.onEdit(host.id)
      }
    },
    {
      id: 'remove',
      label: translate('common.remove', 'Remove'),
      destructive: true,
      closeBeforePress: true,
      onPress: () => {
        args.onRemove(host)
      }
    }
  ]
}
