import { AgentHistoryEmptyList, AgentHistoryLoadState } from './AgentHistoryLoadState'
import { scopeSegments } from './agent-history-scope-segments'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, MessageSquarePlus, Play, RefreshCw } from 'lucide-react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
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
  AgentHistoryInterruptedNotice,
  AgentHistoryResumeNotice,
  AgentHistoryScanNotices,
  AgentHistoryHandoffNotice
} from './AgentHistoryNotices'
import {
  AGENT_HISTORY_DEFAULT_SORT,
  AgentHistoryBottomBar,
  agentHistoryShowsEveryAgent
} from './AgentHistoryBottomBar'
import { useAgentHistoryRestartOffer } from './use-agent-history-restart-offer'
import { TransientToast } from '../components/feedback/TransientToast'
import { useNow } from '../hooks/use-now'
import { useMobileResumeOperationOwnership } from './use-mobile-resume-operation-ownership'
import { conversationCopy } from '../host-screen/conversation-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { AgentHistoryHandoffDrawer } from './AgentHistoryHandoffSheet'
import { useAgentHistoryHandoff } from './use-agent-history-handoff'
import { useAgentHistorySessionResume } from './use-agent-history-session-resume'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  conversationId?: string
  /** `handoff`: opened from the workspace menu to pick a session to hand off. */
  origin?: string
}

export function MobileAgentSessionHistoryPanel(props: MobileAgentSessionHistoryPanelProps) {
  return <MobileAgentSessionHistoryPanelContent key={props.hostId} {...props} />
}

function MobileAgentSessionHistoryPanelContent({
  hostId,
  worktreeId,
  name = '',
  conversationId,
  origin = ''
}: MobileAgentSessionHistoryPanelProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useWorkspaceRouteHandoff()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const claimResumeOwnership = useMobileResumeOperationOwnership(
    hostId,
    worktreeId,
    client,
    connState
  )
  const { worktrees, worktreesLoaded, projectSetups } = useAgentHistoryWorkspaceContext(
    client,
    connState
  )
  const [query, setQuery] = useState('')
  const effectiveQuery = conversationId ? '' : query
  const [agents, setAgents] = useState<readonly AiVault.AiVaultAgent[]>(AiVault.AI_VAULT_AGENTS)
  const [sort, setSort] = useState<AiVault.AiVaultSort>(AGENT_HISTORY_DEFAULT_SORT)
  const [searchBarHeight, setSearchBarHeight] = useState(0)
  const insets = useSafeAreaInsets()
  const now = useNow(30_000)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const pickingHandoff = origin === 'handoff'
  const [actionSession, setActionSession] = useState<AiVault.AiVaultSession | null>(null)

  const {
    scope,
    screenState,
    refreshing,
    revalidating,
    activeWorktreePath,
    scopeFilterPaths,
    onSelectScope,
    onRefresh,
    retry
  } = useMobileAgentHistoryState({
    hostId,
    worktreeId,
    conversationId,
    worktrees,
    worktreesLoaded,
    projectSetups
  })

  const sessions = useMemo(() => {
    const all = screenState.kind === 'ready' ? screenState.sessions : EMPTY_SESSIONS
    return conversationId ? all.filter((session) => session.id === conversationId) : all
  }, [screenState, conversationId])
  const issues = screenState.kind === 'ready' ? screenState.issues : EMPTY_ISSUES
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  )
  const sections = useMemo(
    () =>
      buildMobileAgentHistorySections(sessions, {
        query: effectiveQuery,
        agents,
        sort,
        scope: conversationId ? 'all' : scope,
        scopeFilterPaths,
        activeWorktreePath,
        now
      }),
    [
      sessions,
      effectiveQuery,
      conversationId,
      agents,
      sort,
      scope,
      scopeFilterPaths,
      activeWorktreePath,
      now,
      t
    ]
  )

  const showRefreshLine = useRefreshHint(revalidating)
  const restartOffer = useAgentHistoryRestartOffer(client, connState === 'connected')
  const owner = { hostId, worktreeId, client, connState, worktrees }
  const resume = useAgentHistorySessionResume({ ...owner, origin, claimResumeOwnership })
  const { onResumeSession, resumingSessionId, resumeMessage, setResumeMessage } = resume
  const handoff = useAgentHistoryHandoff({
    ...owner,
    claimOwnership: claimResumeOwnership,
    isBusy: resume.isBusy,
    setBusySessionId: resume.setBusySessionId,
    showMessage: setResumeMessage
  })

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
            pickingHandoff
              ? t('agentHistory.handoff.title', 'Hand off to agent')
              : conversationId
                ? conversationCopy().history
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
            screenState.kind === 'ready' && !conversationId ? (
              <MobileSegmentedControl
                segments={scopeSegments(t)}
                selected={scope}
                onSelect={onSelectScope}
                fill
                style={styles.scopeTabs}
              />
            ) : null
          }
        />
      </SafeAreaView>

      <AgentHistoryLoadState
        state={screenState}
        connected={connState === 'connected'}
        onRetry={retry}
      >
        {conversationId ? null : <AgentHistoryInterruptedNotice offer={restartOffer} />}
        <AgentHistoryHandoffNotice notice={handoff.notice} onDismiss={handoff.dismissNotice} />
        <AgentHistoryScanNotices sessions={sessions} issues={issues} />
        <AgentHistoryResumeNotice
          message={resumeMessage}
          onDismiss={() => setResumeMessage(null)}
        />
        {sections.length === 0 ? (
          <AgentHistoryEmptyList
            query={effectiveQuery}
            agentFiltered={!agentHistoryShowsEveryAgent(agents)}
            conversation={Boolean(conversationId)}
            bottomInset={searchBarHeight}
            onClearQuery={() => setQuery('')}
            onShowAllAgents={() => setAgents(AiVault.AI_VAULT_AGENTS)}
          />
        ) : (
          <MobileAgentSessionHistoryList
            key={conversationId ?? 'history'}
            sections={sections}
            sessionsById={sessionsById}
            refreshing={refreshing}
            showCurrentWorktreeBadges={
              !conversationId && shouldShowMobileCurrentWorktreeBadge(scope)
            }
            initialExpandedId={conversationId}
            hideSectionHeaders={Boolean(conversationId)}
            resumeActionStateBySessionId={resumeActionStateBySessionId}
            onResume={pickingHandoff ? handoff.open : onResumeSession}
            primaryAction={pickingHandoff ? 'handoff' : 'resume'}
            onLongPress={pickingHandoff ? undefined : setActionSession}
            onRefresh={() => void onRefresh()}
            bottomPadding={searchBarHeight}
          />
        )}
        {!conversationId && (
          <AgentHistoryBottomBar
            query={query}
            onQueryChange={setQuery}
            bottomInset={insets.bottom}
            onCoveredHeightChange={setSearchBarHeight}
            sessions={sessions}
            agents={agents}
            sort={sort}
            onAgentsChange={setAgents}
            onSortChange={setSort}
          />
        )}
      </AgentHistoryLoadState>
      <TransientToast message={resume.resumeToast} bottomInset={searchBarHeight} />
      <ActionSheetModal
        visible={actionSession !== null}
        title={actionSession?.title}
        onClose={() => setActionSession(null)}
        actions={
          actionSession
            ? [
                {
                  id: 'resume',
                  label: t('agentHistory.actions.resume', 'Resume'),
                  icon: Play,
                  onPress: () => void onResumeSession(actionSession)
                },
                {
                  id: 'handoff',
                  label: t('agentHistory.handoff.title', 'Hand off to agent'),
                  icon: MessageSquarePlus,
                  closeBeforePress: true,
                  onPress: () => void handoff.open(actionSession)
                }
              ]
            : []
        }
      />
      {handoff.sheet ? <AgentHistoryHandoffDrawer {...handoff.sheet} /> : null}
    </View>
  )
}

const EMPTY_SESSIONS: AiVault.AiVaultSession[] = []
const EMPTY_ISSUES: AiVault.AiVaultScanIssue[] = []
