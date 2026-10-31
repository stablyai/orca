import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'

/** What Accounts shows before its first snapshot: connecting, offline, a failed load, or loading. */
export function MobileAccountsLoadState({
  connState,
  hostName,
  error,
  onRetry,
  onReconnect
}: {
  connState: ConnectionState
  hostName: string
  error: string | null
  onRetry: () => void
  onReconnect: (() => void) | null
}) {
  const t = useMobileTranslation()
  // A missing host never connects, so its error must not wait behind the connecting spinner.
  if (error && (connState === 'connected' || !hostName)) {
    return (
      <MobileLoadErrorState error={error} onRetry={connState === 'connected' ? onRetry : null} />
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
