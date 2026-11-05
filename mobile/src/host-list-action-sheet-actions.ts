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
    hostDiagnosticsAction(() => args.onDiagnostics(host.id)),
    hostEditAction(() => {
      args.onDismiss()
      args.onEdit(host.id)
    }),
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

// Shared with the host screen's ⋯ menu; each runs once the sheet or menu it sits in has closed.
export function hostDiagnosticsAction(onPress: () => void): ActionSheetAction {
  return {
    id: 'networkDiagnostics',
    label: translate(
      'hostScreen.hostListActionSheetActions.networkDiagnostics',
      'Network diagnostics'
    ),
    icon: Activity,
    closeBeforePress: true,
    onPress
  }
}

export function hostEditAction(onPress: () => void): ActionSheetAction {
  return {
    id: 'editHost',
    label: translate('hostScreen.hostListActionSheetActions.editHost', 'Edit host'),
    icon: Edit3,
    closeBeforePress: true,
    onPress
  }
}
