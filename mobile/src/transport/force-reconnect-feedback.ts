import { Alert, type AlertButton } from 'react-native'

export type ForceReconnectErrorPresentation = {
  title: string
  message: string
}

export function forceReconnectErrorPresentation(error: unknown): ForceReconnectErrorPresentation {
  const detail = error instanceof Error ? error.message : String(error)
  if (/unauthorized|pairing may be revoked/i.test(detail)) {
    return {
      title: 'Pairing no longer works',
      message:
        "This desktop no longer accepts your phone's pairing. Try reconnecting once; if it still fails, re-pair from the desktop."
    }
  }
  if (
    /Request timed out: worktree\.ps|Application RPC channel is still not responding/.test(detail)
  ) {
    return {
      title: "Desktop still isn't responding",
      message:
        'Orca opened a new connection, but the desktop did not respond within 15 seconds. Orca will keep retrying automatically.'
    }
  }
  return {
    title: "Couldn't reconnect to desktop",
    message: 'Make sure desktop Orca is open and both devices are online, then try again.'
  }
}

export function showForceReconnectError(error: unknown, onRetry?: () => void): void {
  const presentation = forceReconnectErrorPresentation(error)
  const buttons: AlertButton[] = [{ text: 'Dismiss', style: 'cancel' }]
  if (onRetry) {
    buttons.push({ text: 'Try again', onPress: onRetry })
  }
  Alert.alert(presentation.title, presentation.message, buttons)
}

export function startForceReconnectWithFeedback(reconnect: () => Promise<void>): void {
  const attempt = () => {
    void reconnect().catch((error: unknown) => showForceReconnectError(error, attempt))
  }
  attempt()
}
