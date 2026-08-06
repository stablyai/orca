import { Edit3, PowerOff, RefreshCw } from 'lucide-react-native'
import type { ActionSheetAction } from './components/ActionSheetModal'
import type { ConnectionState, HostProfile } from './transport/types'

/** Builds the home-screen host long-press menu. Edit and Remove open a second
 *  drawer, so both must defer until this sheet's native Modal has unmounted —
 *  presenting into a live one freezes the whole screen on iOS (issue #8791). */
export function getHostListActionSheetActions(args: {
  host: HostProfile | null
  state: ConnectionState
  /** Label "Connect" (not "Reconnect") when never connected this session, so the verb matches the action. */
  hasEverConnected: boolean
  labels: {
    connect: string
    reconnect: string
    disconnect: string
    editHost: string
    remove: string
  }
  onDismiss: () => void
  onReconnect: (hostId: string) => void
  onDisconnect: (hostId: string) => void
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
      label: args.hasEverConnected && isLive ? args.labels.reconnect : args.labels.connect,
      icon: RefreshCw,
      onPress: () => {
        args.onDismiss()
        args.onReconnect(host.id)
      }
    },
    ...(isLive
      ? [
          {
            label: args.labels.disconnect,
            icon: PowerOff,
            onPress: () => {
              args.onDismiss()
              args.onDisconnect(host.id)
            }
          }
        ]
      : []),
    {
      label: args.labels.editHost,
      icon: Edit3,
      closeBeforePress: true,
      onPress: () => {
        args.onDismiss()
        args.onEdit(host.id)
      }
    },
    {
      label: args.labels.remove,
      destructive: true,
      closeBeforePress: true,
      onPress: () => {
        args.onRemove(host)
      }
    }
  ]
}
