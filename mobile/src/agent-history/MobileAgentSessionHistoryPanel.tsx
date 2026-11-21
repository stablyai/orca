import { AgentHistoryEmptyList, AgentHistoryLoadState } from './AgentHistoryLoadState'
import { scopeSegments } from './agent-history-scope-segments'
import { openMobileAgentHistoryChat } from './open-mobile-agent-history-chat'
import { mobileStructuredSessionOpenMessage } from '../session/native-chat/agent-session/mobile-structured-session-open-message'
import { prepareMobileHistoryResumeTarget } from './mobile-history-resume-target-preparation'
import { useResumedHistoryTerminalOpener } from './open-resumed-history-terminal'
import { useCallback, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useWorkspaceClient } from '../worktree/execution-hosts/use-workspace-client'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { getWorktreeLabel } from '../worktree/row-presentation/worktree-label'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  readMobileAiVaultResumeHost,
  readMobileRuntimeTerminalWindowsShell,
  resumeAiVaultSessionInTerminal
} from './ai-vault-resume-launch'
import {
  aiVaultResumeRefusalText,
  prepareMobileAiVaultSessionResume
} from './ai-vault-resume-preparation'
import { hostViewModeForNewAgentTab } from '../storage/session-view-preferences'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import * as AiVault from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'
import { agentHistoryHostStatusRead } from './mobile-agent-history-operations'
import { useAgentHistoryWorkspaceContext } from './use-agent-history-workspace-context'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { useRefreshHint } from '../query/refresh-hint'
import { buildMobileAgentHistorySections } from './agent-history-sections'
import { shouldShowMobileCurrentWorktreeBadge } from './agent-history-current-worktree-badge'
import { MobileAgentSessionHistoryList } from './MobileAgentSessionHistoryList'
import { buildMobileAgentHistoryResumeActionState } from './agent-history-session-card'
import { styles } from './agent-history-styles'
import {
  AgentHistoryInterruptedNotice,
  AgentHistoryResumeNotice,
  AgentHistoryScanNotices
} from './AgentHistoryNotices'
import {
  AGENT_HISTORY_DEFAULT_SORT,
  AgentHistoryBottomBar,
  agentHistoryShowsEveryAgent
} from './AgentHistoryBottomBar'
import { useAgentHistoryRestartOffer } from './use-agent-history-restart-offer'
import { TransientToast, useTransientToast } from '../components/feedback/TransientToast'
import { useNow } from '../hooks/use-now'
import { useMobileResumeOperationOwnership } from './use-mobile-resume-operation-ownership'
import { conversationCopy } from '../host-screen/conversation-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export type MobileAgentSessionHistoryPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  conversationId?: string
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
  // Use handoff, not useRouter: resumed session is a native route outside this single-document page.
  const router = useWorkspaceRouteHandoff()
  const openResumedTerminal = useResumedHistoryTerminalOpener(hostId, worktreeId)
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
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const { message: resumeToast, showToast: showResumeToast } = useTransientToast()
  const now = useNow(30_000)
  const resumeLaunchInFlightRef = useRef(false)
  const resumeMutationRegistryRef = useRef(
    createMobileAiVaultResumeMutationRegistry(createMobileAiVaultResumeMutationId)
  )
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

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

  const resumeActionStateBySessionId = useMemo(
    () => buildMobileAgentHistoryResumeActionState(sessions, resumingSessionId),
    [resumingSessionId, sessions]
  )

  const onResumeSession = useCallback(
    async (session: AiVault.AiVaultSession): Promise<void> => {
      if (resumeLaunchInFlightRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        setResumeMessage(t('agentHistory.panel.waitingForHost', 'Waiting for host...'))
        triggerError()
        return
      }

      const assertCurrentOwner = claimResumeOwnership()
      resumeLaunchInFlightRef.current = true
      setResumingSessionId(session.id)
      setResumeMessage(null)
      try {
        if (
          await openMobileAgentHistoryChat({
            client,
            session,
            hostId,
            assertCurrentOwner,
            opened: (href) => {
              triggerSuccess()
              router.replace(href)
            },
            failed: (reason, workspaceKind) => {
              triggerError()
              const message = mobileStructuredSessionOpenMessage(
                reason,
                session.agent,
                undefined,
                workspaceKind
              )
              const showMessage =
                reason === 'workspace-missing' ? showResumeToast : setResumeMessage
              showMessage(message)
            }
          })
        ) {
          return
        }
        if (!session.sessionId) {
          setResumeMessage(
            t('agentHistory.panel.missingResumeId', 'This session is missing a resume id.')
          )
          triggerError()
          return
        }
        // Read at resume, not on open: the Windows shell setting can change while connected.
        const statusReply = await agentHistoryHostStatusRead.request(client)
        assertCurrentOwner()
        const hostStatus = interpretOrThrowRefusalMessage(
          () => agentHistoryHostStatusRead.interpret(statusReply),
          t('agentHistory.useAgentHistoryState.hostUnreachable', 'Unable to reach host')
        )
        const resumeHost = readMobileAiVaultResumeHost(hostStatus)
        const preparedTarget = await prepareMobileHistoryResumeTarget({
          client,
          session,
          worktreeId,
          worktrees,
          hostPlatform: resumeHost.platform,
          assertCurrentOwner,
          unknownPlatformMessage: () =>
            t('agentHistory.panel.unknownHostPlatform', 'Unable to determine host platform.')
        })
        if (preparedTarget.status !== 'ready') {
          setResumeMessage(preparedTarget.message)
          triggerError()
          return
        }
        const { target, platform, settings } = preparedTarget

        const preparedSession = await prepareMobileAiVaultSessionResume(client, session)
        assertCurrentOwner()
        const launch = buildMobileAiVaultResumeLaunch({
          session: preparedSession,
          workspacePlatform: platform,
          hostTerminalWindowsShell: readMobileRuntimeTerminalWindowsShell(hostStatus),
          settings
        })
        const resumed = await resumeAiVaultSessionInTerminal(
          client,
          target.worktreeId,
          {
            ...launch,
            hostCapabilities: resumeHost.capabilities,
            clientMutationId: resumeMutationRegistryRef.current.claim(session.id),
            viewMode: await hostViewModeForNewAgentTab(launch.launchAgent)
          },
          assertCurrentOwner
        )
        resumeMutationRegistryRef.current.releaseOnSuccess(session.id)
        triggerSuccess()
        // The host accepted the resume; a cutover now only stops navigation.
        try {
          assertCurrentOwner()
        } catch {
          return
        }
        setResumeMessage(t('agentHistory.panel.sessionQueued', 'Agent session queued.'))
        openResumedTerminal({
          worktreeId: target.worktreeId,
          resumed,
          fromSession: origin === 'session' && target.worktreeId === worktreeId
        })
      } catch (err) {
        triggerError()
        setResumeMessage(
          err instanceof Error
            ? (aiVaultResumeRefusalText(err.message, session.agent) ?? err.message)
            : t('agentHistory.panel.resumeFailed', 'Failed to resume session.')
        )
      } finally {
        resumeLaunchInFlightRef.current = false
        setResumingSessionId(null)
      }
    },
    [
      client,
      connState,
      hostId,
      origin,
      openResumedTerminal,
      router,
      worktreeId,
      worktrees,
      claimResumeOwnership,
      showResumeToast,
      t
    ]
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
            conversationId
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
            onResume={onResumeSession}
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
      <TransientToast message={resumeToast} bottomInset={searchBarHeight} />
    </View>
  )
}

const EMPTY_SESSIONS: AiVault.AiVaultSession[] = []
const EMPTY_ISSUES: AiVault.AiVaultScanIssue[] = []

function createMobileAiVaultResumeMutationId(sessionId: string): string {
  const sessionPart = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'session'
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `ai-vault-resume:${sessionPart}:${Date.now().toString(36)}:${randomPart}`
}
