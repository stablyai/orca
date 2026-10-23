import { CloudOff, KeyRound } from 'lucide-react-native'
import { StateView } from '../components/ui/StateView'
import type { MobileSessionController } from './use-mobile-session-controller'

/** A session with no tabs and no desktop: says what is wrong and what will happen. */
export function MobileSessionOfflineState({ controller }: { controller: MobileSessionController }) {
  const { connState, connectionVerdict, hostId, forceReconnectHost, requestLeaveSession } =
    controller
  const back = { label: 'Back to workspaces', onPress: requestLeaveSession }
  // Not on the page: the shell owns the connection there, so a retry could only do nothing.
  const retry =
    hostId && forceReconnectHost
      ? { label: 'Try again', onPress: () => void forceReconnectHost(hostId) }
      : undefined

  if (connectionVerdict.kind === 'auth-failed' || connState === 'auth-failed') {
    return (
      <StateView
        icon={KeyRound}
        title="This phone is no longer paired"
        message="Pair it with your desktop again to open this workspace."
        secondary={back}
      />
    )
  }
  if (connectionVerdict.kind === 'warning' || connectionVerdict.kind === 'unreachable') {
    return (
      <StateView
        icon={CloudOff}
        title={connectionVerdict.label}
        message={
          connectionVerdict.detail ??
          connectionVerdict.hint ??
          'Your tabs come back as soon as the desktop is reachable.'
        }
        primary={retry}
        secondary={back}
      />
    )
  }
  if (connState === 'disconnected') {
    return (
      <StateView
        icon={CloudOff}
        title="Desktop is offline"
        message="Your tabs come back as soon as the desktop is reachable."
        primary={retry}
        secondary={back}
      />
    )
  }
  return <StateView loading title="Connecting to your desktop…" />
}
