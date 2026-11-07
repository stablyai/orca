import type { ReactNode } from 'react'
import { History } from 'lucide-react-native'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { AgentHistoryScreenState } from './mobile-agent-history-screen-state'

export function AgentHistoryLoadState({
  state,
  connected,
  onRetry,
  children
}: {
  state: AgentHistoryScreenState
  connected: boolean
  onRetry: (() => void) | null
  children: ReactNode
}) {
  const t = useMobileTranslation()
  if (state.kind === 'loading') {
    return (
      <MobileStateView loading title={t('agentHistory.panel.loading', 'Loading agent sessions…')} />
    )
  }
  if (state.kind === 'unsupported') {
    return (
      <MobileStateView
        icon={History}
        title={t('agentHistory.panel.unavailable', 'Agent Session History Unavailable')}
        message={t(
          'agentHistory.panel.updateHost',
          'Update Orca on this host to browse agent session history.'
        )}
      />
    )
  }
  if (state.kind === 'error') {
    return connected ? (
      <MobileLoadErrorState error={state.message} onRetry={onRetry} />
    ) : (
      <MobileOfflineState onReconnect={onRetry} />
    )
  }
  return <>{children}</>
}
