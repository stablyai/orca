import type { ReactNode } from 'react'
import { History } from 'lucide-react-native'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../components/feedback/MobileStateView'
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

/** A loaded list with nothing to show: a search or agent filter to clear, or nothing in scope. */
export function AgentHistoryEmptyList({
  query,
  agentFiltered,
  conversation,
  bottomInset,
  onClearQuery,
  onShowAllAgents
}: {
  query: string
  agentFiltered: boolean
  /** One conversation's history, which this host could not find. */
  conversation: boolean
  bottomInset: number
  onClearQuery: () => void
  onShowAllAgents: () => void
}) {
  const t = useMobileTranslation()
  if (query) {
    return (
      <MobileNoMatchState
        message={t('agentHistory.panel.noSearchResults', 'No sessions match your search.')}
        onClear={onClearQuery}
        bottomInset={bottomInset}
      />
    )
  }
  if (agentFiltered) {
    return (
      <MobileNoMatchState
        onClear={onShowAllAgents}
        clearLabel={t('agentHistory.panel.showAllAgents', 'Show all agents')}
        bottomInset={bottomInset}
      />
    )
  }
  return (
    <MobileStateView
      icon={History}
      title={t('agentHistory.panel.noSessions', 'No agent sessions')}
      message={
        conversation
          ? t(
              'agentHistory.panel.conversationUnavailable',
              "This conversation's history is unavailable on this host."
            )
          : t('agentHistory.panel.emptyScope', 'No past agent sessions in this scope.')
      }
      bottomInset={bottomInset}
    />
  )
}
