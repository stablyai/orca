import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, History, MessageSquarePlus, Play, RefreshCw } from 'lucide-react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../components/controls/MobileSegmentedControl'
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
  AgentHistoryScanNotices,
  agentHistoryInterruptedShown,
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
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { AgentHistoryHandoffDrawer } from './AgentHistoryHandoffSheet'
import { useAgentHistoryHandoff } from './use-agent-history-handoff'
import { latestSessionConversationTurn } from '../../../src/shared/ai-vault/session-display/ai-vault-session-display'
import { blockingAiVaultScanIssue } from '../../../src/shared/ai-vault/scanning/ai-vault-scan-issue-state'
import { useAgentHistorySessionResume } from './use-agent-history-session-resume'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  /** `handoff`: opened from the workspace menu to pick a session to hand off. */
  origin?: string
}

function scopeSegments(t: Translate): MobileSegment<AiVault.AiVaultScope>[] {
  return [
    { value: 'workspace', label: t('agentHistory.panel.workspace', 'Workspace') },
    { value: 'project', label: t('agentHistory.panel.project', 'Project') },
    { value: 'all', label: t('agentHistory.panel.all', 'All') }
  ]
}

export function MobileAgentSessionHistoryPanel(props: MobileAgentSessionHistoryPanelProps) {
  return <MobileAgentSessionHistoryPanelContent key={props.hostId} {...props} />
}

function MobileAgentSessionHistoryPanelContent({
  hostId,
  worktreeId,
  name = '',
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
  } = useMobileAgentHistoryState({ hostId, worktreeId, worktrees, worktreesLoaded, projectSetups })

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
        agents,
        sort,
        scope,
        scopeFilterPaths,
        activeWorktreePath,
        now
      }),
    [sessions, query, agents, sort, scope, scopeFilterPaths, activeWorktreePath, now, t]
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

  // A failed scan explains the empty list, so it outranks every other notice.
  const scanBlocked = blockingAiVaultScanIssue({ sessions, issues }) !== null
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
              : t('agentHistory.panel.title', 'Agent history')
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

      {screenState.kind === 'loading' ? (
        <MobileStateView
          loading
          title={t('agentHistory.panel.loading', 'Loading agent sessions…')}
        />
      ) : screenState.kind === 'unsupported' ? (
        <MobileStateView
          icon={History}
          title={t('agentHistory.panel.unavailable', 'Agent history unavailable')}
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
          {/* One notice at most: why the list is empty, what just happened, what waits, what the scan found. */}
          <AgentHistoryResumeNotice
            message={scanBlocked ? null : resumeMessage}
            onDismiss={() => setResumeMessage(null)}
          />
          <AgentHistoryHandoffNotice
            notice={scanBlocked || resumeMessage ? null : handoff.notice}
            onDismiss={handoff.dismissNotice}
          />
          {scanBlocked ? (
            <AgentHistoryScanNotices sessions={sessions} issues={issues} />
          ) : resumeMessage || handoff.notice ? null : (
            <>
              <AgentHistoryInterruptedNotice offer={restartOffer} />
              {agentHistoryInterruptedShown(restartOffer) ? null : (
                <AgentHistoryScanNotices sessions={sessions} issues={issues} />
              )}
            </>
          )}
          {sections.length === 0 ? (
            query ? (
              <MobileNoMatchState
                message={t('agentHistory.panel.noSearchResults', 'No sessions match your search.')}
                onClear={() => setQuery('')}
                bottomInset={searchBarHeight}
              />
            ) : !agentHistoryShowsEveryAgent(agents) ? (
              <MobileNoMatchState
                onClear={() => setAgents(AiVault.AI_VAULT_AGENTS)}
                clearLabel={t('agentHistory.panel.showAllAgents', 'Show all agents')}
                bottomInset={searchBarHeight}
              />
            ) : (
              <MobileStateView
                icon={History}
                title={t('agentHistory.panel.noSessions', 'No agent sessions')}
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
              onResume={pickingHandoff ? handoff.open : onResumeSession}
              primaryAction={pickingHandoff ? 'handoff' : 'resume'}
              onLongPress={pickingHandoff ? undefined : setActionSession}
              onRefresh={() => void onRefresh()}
              bottomPadding={searchBarHeight}
            />
          )}
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
        </>
      )}
      <TransientToast message={resume.resumeToast} bottomInset={searchBarHeight} />
      <ActionSheetModal
        visible={actionSession !== null}
        title={actionSession?.title}
        // The last thing said, so a long-press shows where the session left off before resuming it.
        {...(actionSession
          ? { message: latestSessionConversationTurn(actionSession)?.text.trim() || undefined }
          : {})}
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
