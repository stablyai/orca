import { useEffect, useState } from 'react'
import { CircleAlert, SquareTerminal } from 'lucide-react-native'
import { MobileOfflineState, MobileStateView } from '../components/feedback/MobileStateView'
import { describeLoadError } from '../components/feedback/load-error-description'
import { formatOfflineAsOfTime } from '../components/host-connection/offline-as-of-time'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/connection/connection-state'
import { useLastSessionTabsAt } from './tabs/mobile-session-last-tabs'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useDesktopLinkPairingCopy } from '../components/host-connection/desktop-link-pairing-copy'
import { useOptionalHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'

// Tab hydration retries on its own; past this a person needs to know it stalled and how to nudge it.
const TABS_STALL_MS = 12_000

/** The session body before it has a tab to show: connecting, offline, loading, stalled or empty. */
export function MobileSessionContentState({
  connState,
  hostName,
  lastTabs,
  loading,
  creating,
  createError,
  onReconnect,
  onRetryTabs,
  onCreateTab
}: {
  connState: ConnectionState
  hostName: string | null
  /** The workspace whose remembered strip is drawn above this body, if any. */
  lastTabs: { hostId: string; worktreeId: string } | null
  loading: boolean
  creating: boolean
  createError: string
  onReconnect: (() => void) | null
  onRetryTabs: () => void
  onCreateTab: () => void
}) {
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  // A phone paired with a desktop link is shown no chats, so an empty workspace may still hold some.
  const chatsHidden = useOptionalHostProtocolGates()?.agentSessionsHidden === true
  const chatsHiddenCopy = useDesktopLinkPairingCopy()
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
    return lastTabs ? (
      <OfflineUnderLastTabs hostName={hostName} lastTabs={lastTabs} onReconnect={onReconnect} />
    ) : (
      <MobileOfflineState hostName={hostName} onReconnect={onReconnect} />
    )
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
  const createTab = {
    label: t('session.activeContent.createTab', 'Create Tab'),
    onPress: onCreateTab
  }
  // Terminals still work over a desktop link, so Create Tab stays beside Pair again.
  return chatsHidden ? (
    <MobileStateView
      icon={CircleAlert}
      title={chatsHiddenCopy.title}
      message={createFailure?.message ?? chatsHiddenCopy.message}
      details={createFailure?.details}
      action={createTab}
      secondaryAction={{ label: chatsHiddenCopy.repair, onPress: () => router.push('/pair-scan') }}
    />
  ) : (
    <MobileStateView
      icon={SquareTerminal}
      title={t('session.activeContent.noTabs', 'No tabs in this session')}
      message={createFailure?.message}
      details={createFailure?.details}
      action={createTab}
    />
  )
}

// The strip above is the last one the host accepted; the body says once when that was.
function OfflineUnderLastTabs({
  hostName,
  lastTabs,
  onReconnect
}: {
  hostName: string | null
  lastTabs: { hostId: string; worktreeId: string }
  onReconnect: (() => void) | null
}) {
  const t = useMobileTranslation()
  const asOf = useLastSessionTabsAt(lastTabs.hostId, lastTabs.worktreeId)
  return (
    <MobileOfflineState
      hostName={hostName}
      message={
        asOf === null
          ? undefined
          : t('session.contentState.tabsAsOf', 'Tabs as of {{time}}', {
              time: formatOfflineAsOfTime(asOf)
            })
      }
      onReconnect={onReconnect}
    />
  )
}
