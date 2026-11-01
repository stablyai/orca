import { useEffect, useState } from 'react'
import { CircleAlert, SquareTerminal } from 'lucide-react-native'
import { MobileOfflineState, MobileStateView } from '../components/MobileStateView'
import { describeLoadError } from '../components/load-error-description'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'

// Tab hydration retries on its own; past this a person needs to know it stalled and how to nudge it.
const TABS_STALL_MS = 12_000

/** The session body before it has a tab to show: connecting, offline, loading, stalled or empty. */
export function MobileSessionContentState({
  connState,
  hostName,
  loading,
  creating,
  createError,
  onReconnect,
  onRetryTabs,
  onCreateTab
}: {
  connState: ConnectionState
  hostName: string | null
  loading: boolean
  creating: boolean
  createError: string
  onReconnect: (() => void) | null
  onRetryTabs: () => void
  onCreateTab: () => void
}) {
  const t = useMobileTranslation()
  const [stalled, setStalled] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setStalled(false)
    if (!loading) {
      return
    }
    const timer = setTimeout(() => setStalled(true), TABS_STALL_MS)
    return () => clearTimeout(timer)
  }, [loading, attempt])

  if (connState === 'disconnected' || connState === 'reconnecting') {
    return <MobileOfflineState hostName={hostName} onReconnect={onReconnect} />
  }
  if (connState !== 'connected') {
    return (
      <MobileStateView
        loading
        title={
          hostName
            ? t('session.contentState.connectingTo', 'Connecting to {{host}}…', { host: hostName })
            : t('session.contentState.connecting', 'Connecting…')
        }
      />
    )
  }
  if (loading && stalled) {
    return (
      <MobileStateView
        icon={CircleAlert}
        title={t('session.contentState.tabsStalled', 'Tabs are taking longer than expected')}
        action={{
          label: t('common.retry', 'Retry'),
          onPress: () => {
            setAttempt(attempt + 1)
            onRetryTabs()
          }
        }}
      />
    )
  }
  if (loading) {
    return <MobileStateView loading title={t('session.presentation.loadingTabs', 'Loading tabs')} />
  }
  if (creating) {
    return <MobileStateView loading title={t('session.activeContent.creatingTab', 'Creating...')} />
  }
  const createFailure = createError ? describeLoadError(createError, t) : null
  return (
    <MobileStateView
      icon={SquareTerminal}
      title={t('session.activeContent.noTabs', 'No tabs in this session')}
      message={createFailure?.message}
      details={createFailure?.details}
      action={{ label: t('session.activeContent.createTab', 'Create Tab'), onPress: onCreateTab }}
    />
  )
}
