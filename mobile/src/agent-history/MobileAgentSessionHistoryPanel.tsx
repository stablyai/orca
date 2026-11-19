import { MobileHistorySessionActionSheets } from './MobileHistorySessionActionSheets'
import { useMobileHistorySessionResume } from './use-mobile-history-session-resume'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, History, RefreshCw } from 'lucide-react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../components/controls/MobileSegmentedControl'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useWorkspaceClient } from '../worktree/execution-hosts/use-workspace-client'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { getWorktreeLabel } from '../worktree/row-presentation/worktree-label'

import * as AiVault from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'
import { useAgentHistoryWorkspaceContext } from './use-agent-history-workspace-context'
import { useRefreshHint } from '../query/refresh-hint'
import { buildMobileAgentHistorySections } from './agent-history-sections'
import { shouldShowMobileCurrentWorktreeBadge } from './agent-history-current-worktree-badge'
import { MobileAgentSessionHistoryList } from './MobileAgentSessionHistoryList'
import { buildMobileAgentHistoryResumeActionState } from './agent-history-session-card'
import { styles } from './agent-history-styles'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../components/feedback/MobileStateView'
import {
  AgentHistoryInterruptedNotice,
  AgentHistoryResumeNotice,
  AgentHistoryScanNotices
} from './AgentHistoryNotices'
import { AgentHistoryViewControls } from './AgentHistoryViewControls'
import { useAgentHistoryRestartOffer } from './use-agent-history-restart-offer'
import { TransientToast } from '../components/feedback/TransientToast'
import { useNow } from '../hooks/use-now'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  origin?: string
  action?: string
  sessionId?: string
}

function scopeSegments(t: Translate): MobileSegment<AiVault.AiVaultScope>[] {
  return [
    { value: 'workspace', label: t('agentHistory.panel.workspace', 'Workspace') },
    { value: 'project', label: t('agentHistory.panel.project', 'Project') },
    { value: 'all', label: t('agentHistory.panel.all', 'All') }
  ]
}

export function MobileAgentSessionHistoryPanel(props: MobileAgentSessionHistoryPanelProps) {
  return (
    <MobileAgentSessionHistoryPanelContent
      key={`${props.hostId}:${props.worktreeId}:${props.action ?? ''}:${props.sessionId ?? ''}`}
      {...props}
    />
  )
}

function MobileAgentSessionHistoryPanelContent({
  hostId,
  worktreeId,
  name = '',
  origin = '',
  action,
  sessionId
}: MobileAgentSessionHistoryPanelProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Use handoff, not useRouter: resumed session is a native route outside this single-document page.
  const router = useWorkspaceRouteHandoff()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const { worktrees, worktreesLoaded, projectSetups } = useAgentHistoryWorkspaceContext(
    client,
    connState
  )
  const [query, setQuery] = useState('')
  // Desktop History's defaults: every agent, most recently updated first.
  const [agents, setAgents] = useState<readonly AiVault.AiVaultAgent[]>(AiVault.AI_VAULT_AGENTS)
  const [sort, setSort] = useState<AiVault.AiVaultSort>('updated')
  const [searchBarHeight, setSearchBarHeight] = useState(0)
  const insets = useSafeAreaInsets()
  const now = useNow(30_000)
  const {
    onResumeSession,
    resumingSessionId,
    resumeMessage,
    setResumeMessage,
    resumeToast,
    openUnconfirmedContinuation
  } = useMobileHistorySessionResume({ hostId, worktreeId, origin, client, connState, worktrees })
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  const {
    scope,
    capabilities,
    screenState,
    refreshing,
    revalidating,
    activeWorktreePath,
    scopeFilterPaths,
    onSelectScope,
    onRefresh,
    retry
  } = useMobileAgentHistoryState({ hostId, worktreeId, worktrees, worktreesLoaded, projectSetups })

  const [actionSession, setActionSession] = useState<AiVault.AiVaultSession | null>(null)
  const [handoffSession, setHandoffSession] = useState<AiVault.AiVaultSession | null>(null)
  const onSelectSession = (session: AiVault.AiVaultSession) => {
    if (action === 'handoff') {
      setHandoffSession(session)
    } else {
      void onResumeSession(session, { kind: action === 'cli' ? 'cli' : 'resume' })
    }
  }
  const sessions = screenState.kind === 'ready' ? screenState.sessions : EMPTY_SESSIONS
  const issues = screenState.kind === 'ready' ? screenState.issues : EMPTY_ISSUES
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  )
  const sections = useMemo(
    () =>
      buildMobileAgentHistorySections(sessions, {
        query,
        providerSessionId: sessionId,
        agents,
        sort,
        scope,
        scopeFilterPaths,
        activeWorktreePath,
        now
      }),
    [sessions, query, sessionId, agents, sort, scope, scopeFilterPaths, activeWorktreePath, now, t]
  )

  const showRefreshLine = useRefreshHint(revalidating)
  const restartOffer = useAgentHistoryRestartOffer(client, connState === 'connected')

  const resumeActionStateBySessionId = useMemo(
    () => buildMobileAgentHistoryResumeActionState(sessions, resumingSessionId),
    [resumingSessionId, sessions]
  )

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <NavBar
          leading={
            <NavBarButton
              icon={ChevronLeft}
              onPress={() => router.back()}
              accessibilityLabel={t('common.back', 'Back')}
            />
          }
          title={
            action === 'handoff'
              ? t('agentHistory.actions.handoff', 'Hand off to Another Agent')
              : action === 'cli'
                ? t('session.nativeChatCliFork.resumeInNewCli', 'Resume in New CLI')
                : t('agentHistory.panel.title', 'Agent Session History')
          }
          subtitle={worktreeLabel}
          refreshing={showRefreshLine}
          trailing={
            <NavBarButton
              icon={RefreshCw}
              onPress={() => void onRefresh()}
              accessibilityLabel={t('agentHistory.panel.refreshSessions', 'Refresh agent sessions')}
            />
          }
          accessory={
            screenState.kind === 'ready' ? (
              <View>
                <MobileSegmentedControl
                  segments={scopeSegments(t)}
                  selected={scope}
                  onSelect={onSelectScope}
                  fill
                  style={styles.scopeTabs}
                />
                <AgentHistoryViewControls
                  sessions={sessions}
                  agents={agents}
                  sort={sort}
                  onAgentsChange={setAgents}
                  onSortChange={setSort}
                />
              </View>
            ) : null
          }
        />
      </SafeAreaView>

      {screenState.kind === 'loading' ? (
        <MobileStateView
          loading
          title={t('agentHistory.panel.loading', 'Loading agent sessions…')}
        />
      ) : screenState.kind === 'unsupported' ? (
        <MobileStateView
          icon={History}
          title={t('agentHistory.panel.unavailable', 'Agent Session History Unavailable')}
          message={t(
            'agentHistory.panel.updateHost',
            'Update Orca on this host to browse agent session history.'
          )}
        />
      ) : screenState.kind === 'error' && connState !== 'connected' ? (
        <MobileOfflineState onReconnect={retry} />
      ) : screenState.kind === 'error' ? (
        <MobileLoadErrorState error={screenState.message} onRetry={retry} />
      ) : (
        <>
          <AgentHistoryInterruptedNotice offer={restartOffer} />
          <AgentHistoryScanNotices sessions={sessions} issues={issues} />
          {resumeMessage ? (
            <AgentHistoryResumeNotice
              message={resumeMessage}
              onOpen={openUnconfirmedContinuation}
              onDismiss={() => setResumeMessage(null)}
            />
          ) : null}
          {sections.length === 0 ? (
            query ? (
              <MobileNoMatchState
                message={t('agentHistory.panel.noSearchResults', 'No sessions match your search.')}
                onClear={() => setQuery('')}
                bottomInset={searchBarHeight}
              />
            ) : (
              <MobileStateView
                icon={History}
                title={t('agentHistory.panel.noSessions', 'No agent sessions')}
                message={t(
                  'agentHistory.panel.emptyScope',
                  'No past agent sessions in this scope.'
                )}
                bottomInset={searchBarHeight}
              />
            )
          ) : (
            <MobileAgentSessionHistoryList
              sections={sections}
              sessionsById={sessionsById}
              refreshing={refreshing}
              showCurrentWorktreeBadges={shouldShowMobileCurrentWorktreeBadge(scope)}
              resumeActionStateBySessionId={resumeActionStateBySessionId}
              onResume={onSelectSession}
              onActions={setActionSession}
              resumeLabel={
                action === 'handoff'
                  ? t('agentHistory.actions.handoff', 'Hand off to Another Agent')
                  : action === 'cli'
                    ? t('session.nativeChatCliFork.resumeInNewCli', 'Resume in New CLI')
                    : undefined
              }
              onRefresh={() => void onRefresh()}
              bottomPadding={searchBarHeight}
            />
          )}
          <BottomSearchBar
            value={query}
            onChangeText={setQuery}
            placeholder={t('agentHistory.panel.placeholder', 'Search sessions, repo:, path:')}
            bottomInset={insets.bottom}
            onCoveredHeightChange={setSearchBarHeight}
          />
        </>
      )}
      <MobileHistorySessionActionSheets
        session={actionSession}
        handoffSession={handoffSession}
        client={client}
        worktreeId={worktreeId}
        worktrees={worktrees}
        capabilities={capabilities}
        busy={resumingSessionId !== null || connState !== 'connected'}
        onRun={onResumeSession}
        onHandoff={setHandoffSession}
        onClose={() => {
          setActionSession(null)
          setHandoffSession(null)
        }}
      />
      <TransientToast message={resumeToast} bottomInset={searchBarHeight} />
    </View>
  )
}

const EMPTY_SESSIONS: AiVault.AiVaultSession[] = []
const EMPTY_ISSUES: AiVault.AiVaultScanIssue[] = []
