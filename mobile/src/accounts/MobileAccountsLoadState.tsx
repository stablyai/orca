import { CircleAlert } from 'lucide-react-native'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'

/** Accounts before its first snapshot: connecting, offline, re-pair, failed load or loading. */
export function MobileAccountsLoadState({
  connState,
  hostName,
  error,
  onRetry,
  onReconnect,
  onRepair
}: {
  connState: ConnectionState
  hostName: string
  error: string | null
  onRetry: () => void
  onReconnect: (() => void) | null
  onRepair: () => void
}) {
  const t = useMobileTranslation()
  // A missing host never connects, so its error must not wait behind the connecting spinner.
  if (error && (connState === 'connected' || !hostName)) {
    return (
      <MobileLoadErrorState error={error} onRetry={connState === 'connected' ? onRetry : null} />
    )
  }
  if (connState === 'auth-failed') {
    return (
      <MobileStateView
        icon={CircleAlert}
        title={t('components.hostCard.pairingInvalid', 'Pairing invalid')}
        message={t(
          'accounts.screen.pairingInvalidMessage',
          'Re-pair this phone with your desktop to see its accounts.'
        )}
        action={{
          label: t('components.authFailedBannerActions.repair', 'Re-pair'),
          onPress: onRepair
        }}
      />
    )
  }
  if (connState === 'disconnected' || connState === 'reconnecting') {
    return <MobileOfflineState hostName={hostName} onReconnect={onReconnect} />
  }
  if (connState !== 'connected') {
    return (
      <MobileStateView
        loading
        title={
          hostName
            ? t('accounts.screen.connectingTo', 'Connecting to {{name}}…', { name: hostName })
            : t('accounts.screen.connecting', 'Connecting to host…')
        }
      />
    )
  }
  return (
    <MobileStateView loading title={t('accounts.screen.loadingAccounts', 'Loading accounts…')} />
  )
}
